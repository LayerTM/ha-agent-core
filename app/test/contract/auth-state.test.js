'use strict';

// A sign-in the engine no longer accepts: one reason, never retried, named to the
// client on every path, and published on /api/status without a model call.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CLAUDE_PROMPT_RATE_BURST = '500';
process.env.CLAUDE_PROMPT_RETRY_BACKOFF_MS = '0';
process.env.CLAUDE_PROMPT_MIN_RETRY_BUDGET_MS = '1000';
process.env.CLAUDE_PROMPT_MAX_ATTEMPTS = '2';
process.env.CLAUDE_PROMPT_TIMEOUT_MS = '10000';

const contract = require('../../server/adapter-contract');
const { createNeutralAdapter, okOutcome, errorOutcome } = require('../fixtures/neutral-adapter');

const { adapter, state, run, branding } = createNeutralAdapter();
contract.useAdapter(adapter, branding);

const { createPromptApp, createAuthState } = require('../../server/prompt/server');

const TOKEN = 'auth-state-token-0123456789abcdef';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-auth-state-'));
const INTENT = [{ intent: 'HassTurnOff', targets: ['switch.heater'], data: {} }];

function makeApp(stateDir) {
  return createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-agent'),
    usageBin: path.join(TMP, 'no-usage'),
    haConfigured: true,
    model: '',
    workDir: TMP,
    addonVersion: 'auth-state',
    redact: (s) => s,
    audit: () => {},
    stateDir,
    runAgent: run,
  });
}

function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

const servers = [];
async function start(stateDir) {
  const server = await listen(makeApp(stateDir));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
// A caller of its own per request, so no test meets another's rate budget.
let callerSeq = 0;
const post = (base, body) => {
  callerSeq += 1;
  return fetch(`${base}/api/prompt`, {
    method: 'POST', headers: { ...headers, 'x-claude-caller': `auth-${callerSeq}` }, body: JSON.stringify(body),
  });
};
const status = async (base) => (await (await fetch(`${base}/api/status`, { headers })).json());

let base;
before(async () => { base = await start(fs.mkdtempSync(path.join(TMP, 'state-'))); });
after(() => {
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  state.runs.length = 0;
  state.script.length = 0;
  delete adapter.prompt.credentialsExpiry;
});

test('a read refused for its sign-in is not retried, and the degraded answer names the reason', async () => {
  state.script.push(() => errorOutcome('auth-expired'), () => okOutcome());
  const res = await post(base, { prompt: 'hi', language: 'en' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.degraded, true);
  assert.equal(body.reason, 'auth-expired');
  assert.equal(state.runs.length, 1, 'one engine call: a retry cannot succeed until someone signs in');
  assert.equal((await status(base)).chat_health.last_reason, 'auth-expired');
});

test('a streamed read names the reason on its done line', async () => {
  state.script.push(() => errorOutcome('auth-expired'));
  const res = await post(base, { prompt: 'hi', stream: true });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'done');
  assert.equal(lines[0].reason, 'auth-expired');
});

test('every degraded read names its reason, a passing one too', async () => {
  state.script.push(() => errorOutcome('model-error'), () => errorOutcome('model-error'));
  const body = await (await post(base, { prompt: 'hi' })).json();
  assert.equal(body.reason, 'model-error');
  assert.equal(state.runs.length, 2, 'a transient failure is still retried');
});

test('a write refused for its sign-in answers 503 auth_expired, not internal', async () => {
  state.script.push(() => errorOutcome('auth-expired'), () => okOutcome());
  const res = await post(base, { mode: 'write', intents: INTENT });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'the agent is no longer signed in: sign in again', code: 'auth_expired' });
  assert.equal(state.runs.length, 1);
});

test('status follows the runs: expired after a refusal, ok after the next answer, durable across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'state-'));
  const first = await start(dir);
  assert.deepEqual((await status(first)).auth, { state: 'unknown', since: null });

  const refusedAfter = Date.now();
  state.script.push(() => errorOutcome('auth-expired'));
  await post(first, { prompt: 'hi' });
  const expired = (await status(first)).auth;
  assert.equal(expired.state, 'expired');
  assert.ok(Date.parse(expired.since) >= refusedAfter - 1000);

  // A failure that is not about the sign-in proves nothing either way.
  state.script.push(() => errorOutcome('model-error'), () => errorOutcome('no-result'));
  await post(first, { prompt: 'hi' });
  assert.deepEqual((await status(first)).auth, expired);

  // A restart (a second app over the same state) still knows.
  const second = await start(dir);
  assert.deepEqual((await status(second)).auth, expired);

  state.script.push(() => okOutcome());
  await post(second, { prompt: 'hi' });
  const ok = (await status(second)).auth;
  assert.equal(ok.state, 'ok');
  assert.ok(Date.parse(ok.since) >= Date.parse(expired.since));
  // refused 1 + model-error retried as no-result 2 + answered 1: the status reads ran nothing.
  assert.equal(state.runs.length, 4, 'status itself never runs the engine');
});

test('a credential whose expiry has passed reads expired without a run; a later answer proves it renewed', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'state-'));
  const app = await start(dir);
  const at = Date.now() - 60_000;
  const asked = [];
  adapter.prompt.credentialsExpiry = (args) => { asked.push(args); return at; };
  assert.deepEqual((await status(app)).auth, { state: 'expired', since: new Date(at).toISOString() });
  assert.equal(asked.length, 1);
  assert.equal(typeof asked[0].home, 'string');
  assert.equal(asked[0].env, process.env);
  assert.equal(state.runs.length, 0);

  state.script.push(() => okOutcome());
  await post(app, { prompt: 'hi' });
  assert.equal((await status(app)).auth.state, 'ok');

  // Still in the future: the credential says nothing yet.
  adapter.prompt.credentialsExpiry = () => Date.now() + 3_600_000;
  assert.equal((await status(app)).auth.state, 'ok');
});

test('an adapter that cannot tell, or throws, never makes the sign-in look expired', async () => {
  const app = await start(fs.mkdtempSync(path.join(TMP, 'state-')));
  for (const answer of [() => null, () => 'soon', () => Number.NaN, () => { throw new Error('unreadable'); }]) {
    adapter.prompt.credentialsExpiry = answer;
    assert.deepEqual((await status(app)).auth, { state: 'unknown', since: null });
  }
});

test('the state machine: the newer evidence wins, and only a readable saved state is trusted', () => {
  let clock = 1_000_000;
  const now = () => clock;
  const iso = (ms) => new Date(ms).toISOString();

  const fresh = createAuthState(null, now);
  assert.deepEqual(fresh.snapshot(), { state: 'unknown', since: null });
  // An expiry already passed with no run: expired since that moment.
  assert.deepEqual(fresh.snapshot(900_000), { state: 'expired', since: iso(900_000) });

  fresh.record(true); // answered at 1 000 000
  assert.deepEqual(fresh.snapshot(900_000), { state: 'ok', since: iso(1_000_000) }, 'answered after the expiry');
  clock = 2_000_000;
  assert.deepEqual(fresh.snapshot(1_500_000), { state: 'expired', since: iso(1_500_000) }, 'expired after the answer');

  fresh.record(false); // refused at 2 000 000
  assert.deepEqual(fresh.snapshot(1_500_000), { state: 'expired', since: iso(2_000_000) });
  clock = 2_500_000;
  fresh.record(false); // still refused: the moment it became true does not move
  assert.deepEqual(fresh.snapshot(), { state: 'expired', since: iso(2_000_000) });

  const saves = [];
  const store = (saved) => ({ load: () => saved, save: (v) => saves.push(v) });
  for (const junk of [null, 'expired', { state: 'gone', since: 5 }, { state: 'ok', since: -1 }, { state: 'ok' }]) {
    assert.deepEqual(createAuthState(store(junk), now).snapshot(), { state: 'unknown', since: null }, JSON.stringify(junk));
  }
  const restored = createAuthState(store({ state: 'expired', since: 1234 }), now);
  assert.deepEqual(restored.snapshot(), { state: 'expired', since: iso(1234) });
  restored.record(true);
  assert.deepEqual(saves, [{ state: 'ok', since: 2_500_000 }]);
});

test('credentialsExpiry is an optional adapter member, a function when present', () => {
  const { adapter: plain } = createNeutralAdapter();
  assert.equal(plain.prompt.credentialsExpiry, undefined);
  const withIt = { ...plain, prompt: { ...plain.prompt, credentialsExpiry: () => null } };
  assert.equal(contract.validateAdapter(withIt), withIt);
  assert.throws(
    () => contract.validateAdapter({ ...plain, prompt: { ...plain.prompt, credentialsExpiry: 0 } }),
    /prompt\.credentialsExpiry must be a function when present/,
  );
});
