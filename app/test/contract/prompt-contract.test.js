'use strict';

// The prompt API's engine-independent contract, driven through a neutral adapter
// whose runner records every dispatch. Each refusal is checked to have happened
// WITHOUT a run; each accepted request is checked for what the runner received.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Read by the server at load time.
process.env.CLAUDE_PROMPT_RATE_BURST = '500';
process.env.CLAUDE_PROMPT_RETRY_BACKOFF_MS = '0';
process.env.CLAUDE_PROMPT_MIN_RETRY_BUDGET_MS = '1000';
process.env.CLAUDE_PROMPT_MAX_ATTEMPTS = '2';
process.env.CLAUDE_PROMPT_TIMEOUT_MS = '10000';

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter, okOutcome, errorOutcome, waitForAbort } = require('../fixtures/neutral-adapter');

const TIMEOUT_MS = 10000;
const { adapter, state, run: scriptedRun, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const { createPromptApp } = require('../../server/prompt/server');
const { buildRedactor } = require('../../server/prompt/security');

const TOKEN = 'contract-token-0123456789abcdef';
const SECRET = 'neutral-secret-value-9f8e7d6c';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-contract-'));
const auditLines = [];

function makeApp(overrides = {}) {
  return createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-such-agent'),
    claudeSettings: 'neutral-settings',
    usageBin: path.join(TMP, 'no-such-usage'),
    haConfigured: true,
    mcpConfigPath: path.join(TMP, 'mcp.json'),
    model: 'neutral-model',
    workDir: TMP,
    addonVersion: 'contract',
    redact: buildRedactor([SECRET]),
    audit: (line) => auditLines.push(line),
    runAgent: scriptedRun,
    ...overrides,
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let server;
let base;
let noMcpServer;
let noMcpBase;

before(async () => {
  server = await listen(makeApp());
  base = `http://127.0.0.1:${server.address().port}`;
  noMcpServer = await listen(makeApp({ haConfigured: false, mcpConfigPath: null }));
  noMcpBase = `http://127.0.0.1:${noMcpServer.address().port}`;
});

after(() => {
  for (const s of [server, noMcpServer]) {
    s.closeAllConnections();
    s.close();
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  state.runs.length = 0;
  state.script.length = 0;
  auditLines.length = 0;
});

// Each request comes from its own caller, so the per-caller rate limit (checked
// in its own test) does not shape the others.
let callerSeq = 0;
function post(body, { auth = `Bearer ${TOKEN}`, url = base, raw, signal, caller } = {}) {
  callerSeq += 1;
  const headers = { 'Content-Type': 'application/json', 'x-claude-caller': caller || `contract-${callerSeq}` };
  if (auth !== null) headers.Authorization = auth;
  return fetch(`${url}/api/prompt`, {
    method: 'POST', headers, body: raw !== undefined ? raw : JSON.stringify(body), signal,
  });
}

async function ndjson(res) {
  return (await res.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const INTENT = [{ intent: 'HassTurnOff', targets: ['switch.heater'], data: {} }];

// --- refusals: nothing is dispatched --------------------------------------------

test('a request without the bearer token is refused before anything runs', async () => {
  for (const auth of [null, 'Bearer wrong-token-0123456789abcdef', TOKEN, `Basic ${TOKEN}`]) {
    const res = await post({ prompt: 'hello' }, { auth });
    assert.equal(res.status, 401, String(auth));
    assert.deepEqual(await res.json(), { error: 'unauthorized', code: 'unauthorized' });
  }
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 401);
  assert.equal(state.runs.length, 0);
  assert.ok(auditLines.every((line) => line.startsWith('prompt[deny] reason=401')));
});

test('a malformed body is refused before anything runs, with a code a client can map', async () => {
  /** @type {Array<[{ raw?: string, body?: any }, number, object]>} */
  const cases = [
    [{ raw: '[1]' }, 400, { error: 'body must be a JSON object', code: 'invalid_body' }],
    [{ raw: '{"prompt":' }, 400, { error: 'invalid JSON body', code: 'invalid_json' }],
    [{ raw: JSON.stringify({ prompt: 'x'.repeat(64 * 1024) }) }, 413, { error: 'body too large', code: 'body_too_large', limit_bytes: 64 * 1024 }],
    [{ body: { prompt: 'x', extra: 1 } }, 400, { error: 'unknown field: extra', code: 'unknown_field', field: 'extra' }],
    [{ body: { prompt: 'x', mode: 'admin' } }, 400, { error: 'mode must be "read" or "write"', code: 'invalid_field', field: 'mode' }],
    [{ body: { prompt: '   ' } }, 400, { error: 'prompt must be a non-empty string', code: 'invalid_field', field: 'prompt' }],
    [{ body: { mode: 'write', intents: INTENT, prompt: 7 } }, 400, { error: 'prompt must be a string', code: 'invalid_field', field: 'prompt' }],
    [{ body: { prompt: 'x'.repeat(8 * 1024 + 1) } }, 413, { error: 'prompt too large (max 8 KB)', code: 'prompt_too_large', limit_bytes: 8 * 1024 }],
    [{ body: { prompt: 'x', conversation_id: 7 } }, 400, { error: 'conversation_id must be a string', code: 'invalid_field', field: 'conversation_id' }],
    [{ body: { prompt: 'x', language: 7 } }, 400, { error: 'language must be a string', code: 'invalid_field', field: 'language' }],
    [{ body: { prompt: 'x', surface: 'screen' } }, 400, { error: 'surface must be "voice" or "text"', code: 'invalid_field', field: 'surface' }],
    [{ body: { prompt: 'x', edit_automation: [] } }, 400, { error: 'edit_automation must be a JSON object', code: 'invalid_field', field: 'edit_automation' }],
    [{ body: { prompt: 'x', stream: 'yes' } }, 400, { error: 'stream must be a boolean', code: 'invalid_field', field: 'stream' }],
    [{ body: { prompt: 'x', image_entity: 'light.kitchen' } }, 400, { error: 'image_entity must be a camera.<id> entity', code: 'invalid_field', field: 'image_entity' }],
    [{ body: { prompt: 'x', intents: INTENT } }, 400, { error: 'intents is only valid with mode "write"', code: 'mode_mismatch', field: 'intents' }],
    [{ body: { prompt: 'x', confirmation: 'auto' } }, 400, { error: 'confirmation is only valid with mode "write"', code: 'mode_mismatch', field: 'confirmation' }],
    [{ body: { mode: 'write', intents: INTENT, stream: true } }, 400, { error: 'stream is only valid with mode "read"', code: 'mode_mismatch', field: 'stream' }],
    [{ body: { mode: 'write', intents: INTENT, image_entity: 'camera.door' } }, 400, { error: 'image_entity is only valid with mode "read"', code: 'mode_mismatch', field: 'image_entity' }],
    [{ body: { mode: 'write', intents: INTENT, confirmation: 'maybe' } }, 400, { error: 'confirmation must be "auto" or "confirmed"', code: 'invalid_field', field: 'confirmation' }],
    [{ body: { mode: 'write', intents: [] } }, 400, { error: 'intents must be an array of 1-5 entries', code: 'invalid_intents', field: 'intents' }],
  ];
  for (const [req, status, expected] of cases) {
    const res = await post(req.body, { raw: req.raw });
    assert.equal(res.status, status, expected.error);
    assert.deepEqual(await res.json(), expected);
  }
  assert.equal(state.runs.length, 0);
});

test('every error answer goes through the one table of codes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'prompt', 'server.js'), 'utf8');
  assert.deepEqual(source.match(/\.status\(\s*[45]\d\d\s*\)\s*\.json\(/g), null,
    'an error status is sent only by sendError, so it always carries a code');
});

test('status publishes the size limits the prompt request is held to', async () => {
  const res = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  assert.equal(body.prompt_max_bytes, 8 * 1024);
  assert.equal(body.body_max_bytes, 64 * 1024);
  const atLimit = await post({ prompt: 'x'.repeat(body.prompt_max_bytes) });
  assert.equal(atLimit.status, 200, 'a prompt of exactly the limit is accepted');
});

test('a write whose intents are not acceptable is refused before anything runs', async () => {
  for (const intents of [undefined, [], [{ intent: 'Bash', targets: ['switch.x'] }], [{ intent: 'HassTurnOff', targets: ['../etc/passwd'] }]]) {
    const res = await post({ mode: 'write', intents });
    assert.equal(res.status, 400, JSON.stringify(intents));
  }
  const auto = await post({ mode: 'write', confirmation: 'auto', intents: [{ intent: 'HassTurnOff', targets: ['lock.front_door'] }] });
  assert.equal(auto.status, 403);
  assert.deepEqual(await auto.json(), {
    error: 'sensitive action requires explicit confirmation', code: 'confirmation_required', domains: ['lock'],
  });
  const noMcp = await post({ mode: 'write', intents: INTENT }, { url: noMcpBase });
  assert.equal(noMcp.status, 503);
  assert.equal(state.runs.length, 0);
  assert.ok(auditLines.some((line) => line.includes('reason=auto-critical') && line.includes('domains=lock')));
  assert.ok(auditLines.some((line) => line.includes('reason=503-no-mcp')));
});

test('a server built without saying whether Home Assistant is configured refuses to start, loudly', () => {
  // Silently falsy would mean every write refused and nothing said; the start's
  // own gates refuse AND name the reason, and so does this.
  assert.throws(() => makeApp({ haConfigured: undefined }), /haConfigured must be true or false/);
});

test('whether Home Assistant is configured is a fact of its own, not the presence of a config file', async () => {
  // The config file is written per run, so between runs there is none while Home
  // Assistant is configured all the same. Nothing may read the path to answer this.
  const server_ = await listen(makeApp({ haConfigured: true, mcpConfigPath: null }));
  const url = `http://127.0.0.1:${server_.address().port}`;
  try {
    const status = await (await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(status.ha_mcp, true, 'configured, though this moment has no config file');
    const seen = auditLines.length;
    const write = await post({ mode: 'write', intents: INTENT }, { url });
    assert.notEqual(write.status, 503, 'a write is not refused for a file that is written per run');
    assert.ok(!auditLines.slice(seen).some((line) => line.includes('reason=503-no-mcp')));
  } finally {
    server_.close();
  }
});

test('a caller over its rate limit is refused before anything runs', async () => {
  const statuses = [];
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    statuses.push((await post({ prompt: `burst ${i}` }, { caller: 'one-busy-caller' })).status);
  }
  const limited = statuses.filter((status) => status === 429).length;
  assert.ok(limited > 0, `no request was limited: ${statuses}`);
  assert.equal(state.runs.length, statuses.filter((status) => status === 200).length);
  assert.ok(auditLines.some((line) => line === 'prompt[deny] reason=429 caller=one-busy-caller'));
});

// --- read -------------------------------------------------------------------------

test('a read dispatches one run with the request and answers with its redacted result', async () => {
  state.script.push(() => okOutcome({ text: `the value is ${SECRET}`, toolsUsed: [`tool-${SECRET}`] }));
  const res = await post({ prompt: `what is on?${String.fromCharCode(7)}`, language: 'uk', surface: 'voice' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    text: 'the value is [REDACTED]', proposal: null, tools_used: ['tool-[REDACTED]'], truncated: false,
  });
  assert.equal(state.runs.length, 1);
  const run = state.runs[0];
  assert.equal(run.mode, 'read');
  assert.equal(run.prompt, 'what is on?');
  assert.deepEqual(run.intents, []);
  assert.equal(run.bin, path.join(TMP, 'no-such-agent'));
  assert.equal(run.settings, 'neutral-settings');
  assert.equal(run.cwd, TMP);
  assert.equal(run.model, 'neutral-model');
  assert.equal(run.language, 'uk');
  assert.equal(run.surface, 'voice');
  assert.equal(run.timeoutMs, undefined, 'the first attempt gets the full ceiling');
  assert.ok(run.signal instanceof AbortSignal);
  assert.equal(run.signal.aborted, false);
  assert.ok(auditLines.some((line) => line.startsWith('prompt[read] ') && line.includes(' status=200 ')));
});

test('a streamed read sends deltas and ends with exactly one done line', async () => {
  const answer = `${'streamed words '.repeat(20)}end`;
  state.script.push((opts) => {
    opts.onText(answer.slice(0, 150));
    opts.onText(answer);
    return okOutcome({ text: answer });
  });
  const res = await post({ prompt: 'stream it', stream: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const lines = await ndjson(res);
  const last = lines.pop();
  assert.equal(last.type, 'done');
  assert.equal(last.text, answer);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((line) => line.type === 'delta'));
  assert.equal(lines.map((line) => line.text).join(''), answer);
});

test('a read that fails transiently is retried within the remaining time, once', async () => {
  state.script.push(() => errorOutcome('model-error'), () => okOutcome({ text: 'second time' }));
  const res = await post({ prompt: 'retry me' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'second time');
  assert.equal(state.runs.length, 2);
  assert.equal(typeof state.runs[1].timeoutMs, 'number');
  assert.ok(state.runs[1].timeoutMs > 0 && state.runs[1].timeoutMs <= TIMEOUT_MS);
  assert.ok(auditLines.some((line) => line.includes('attempts=2 recovered=model-error')));

  state.runs.length = 0;
  state.script.push(() => errorOutcome('model-error'), () => errorOutcome('model-error'), () => okOutcome());
  const exhausted = await post({ prompt: 'retry me again' });
  assert.equal(exhausted.status, 200);
  assert.equal((await exhausted.json()).degraded, true);
  assert.equal(state.runs.length, 2, 'no more attempts than the configured maximum');
});

test('a read that fails permanently degrades to a friendly answer without a retry', async () => {
  state.script.push(() => errorOutcome('permission-denied'));
  const res = await post({ prompt: 'fail', language: 'en' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.degraded, true);
  assert.deepEqual(body.tools_used, []);
  assert.equal(body.proposal, null);
  assert.equal(state.runs.length, 1);
});

test('a streamed read never ends with an error line', async () => {
  state.script.push(() => errorOutcome('permission-denied'));
  const failed = await ndjson(await post({ prompt: 'fail', stream: true }));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].type, 'done');
  assert.equal(failed[0].degraded, true);

  state.script.push(() => okOutcome({ status: 'timeout', text: '' }));
  const late = await ndjson(await post({ prompt: 'slow', stream: true }));
  assert.equal(late.length, 1);
  assert.equal(late[0].type, 'done');
  assert.equal(late[0].degraded, true);
});

test('a run that reports a timeout answers 504', async () => {
  state.script.push(() => okOutcome({ status: 'timeout', text: '' }));
  const res = await post({ prompt: 'slow' });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: 'timeout', code: 'timeout' });
  assert.equal(state.runs.length, 1);
});

// --- write ------------------------------------------------------------------------

test('a confirmed write hands exactly the validated intents to one run', async () => {
  const intents = [
    { intent: 'HassTurnOff', targets: ['switch.heater'], data: {} },
    { intent: 'HassTurnOn', targets: ['light.kitchen', 'light.hall'], data: {} },
  ];
  state.script.push(() => okOutcome({ text: 'done', toolsUsed: ['ha'] }));
  const res = await post({ mode: 'write', intents, prompt: 'user words are audit-only' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'done');
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].mode, 'write');
  assert.deepEqual(state.runs[0].intents.map((i) => [i.intent, i.targets]), intents.map((i) => [i.intent, i.targets]));
  assert.equal(state.runs[0].history, undefined);
  assert.ok(auditLines.some((line) => line.startsWith('prompt[write] ')
    && line.includes('intents=HassTurnOff(switch.heater),HassTurnOn(light.kitchen+light.hall)')));
});

test('a failed write is reported as a failure and never repeated', async () => {
  for (const reason of ['model-error', 'no-result', 'permission-denied']) {
    state.runs.length = 0;
    state.script.push(() => errorOutcome(reason, { toolsUsed: ['ha'] }), () => okOutcome());
    const res = await post({ mode: 'write', intents: INTENT });
    assert.equal(res.status, 500, reason);
    assert.deepEqual(await res.json(), { error: 'internal error', code: 'internal' });
    assert.equal(state.runs.length, 1, `${reason}: a write ran twice`);
    state.script.length = 0;
  }
  state.runs.length = 0;
  state.script.push(() => okOutcome({ status: 'timeout', text: '' }), () => okOutcome());
  const timedOut = await post({ mode: 'write', intents: INTENT });
  assert.equal(timedOut.status, 504);
  assert.equal(state.runs.length, 1);
});

test('the only write retry is a tool-name mismatch before any tool ran', async () => {
  state.script.push(() => errorOutcome('tool-name-mismatch', { toolsUsed: [], haTools: ['ha_turn_off'] }), () => okOutcome());
  const res = await post({ mode: 'write', intents: INTENT });
  assert.equal(res.status, 200);
  assert.equal(state.runs.length, 2);
  assert.deepEqual(state.runs[1].haTools, ['ha_turn_off'], 'the retry uses the names the first run reported');

  state.runs.length = 0;
  state.script.push(() => errorOutcome('tool-name-mismatch', { toolsUsed: ['ha_turn_off'] }), () => okOutcome());
  const ran = await post({ mode: 'write', intents: INTENT });
  assert.equal(ran.status, 500);
  assert.equal(state.runs.length, 1);
  state.script.length = 0;
});

// --- cancellation and concurrency ---------------------------------------------------

test('a client that disconnects cancels its run, and the slot is released', async () => {
  state.script.push(waitForAbort);
  const controller = new AbortController();
  const pending = post({ prompt: 'long' }, { signal: controller.signal }).catch((err) => err);
  while (state.runs.length === 0) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 5); });
  }
  const { signal } = state.runs[0];
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal((await pending).name, 'AbortError');
  const deadline = Date.now() + 2000;
  while (!signal.aborted && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 5); });
  }
  assert.equal(signal.aborted, true);
  assert.equal(state.runs.length, 1, 'a cancelled run is not retried');
  // Both slots are free again.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await post({ prompt: `after ${i}` })).status, 200);
  }
});

test('at most two runs at once; a third request is refused without dispatch', async () => {
  const release = [];
  const hold = () => new Promise((resolve) => { release.push(() => resolve(okOutcome())); });
  state.script.push(hold, hold);
  const first = post({ prompt: 'one' });
  const second = post({ prompt: 'two' });
  while (state.runs.length < 2) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 5); });
  }
  const third = await post({ prompt: 'three' });
  assert.equal(third.status, 503);
  assert.deepEqual(await third.json(), { error: 'busy', code: 'busy' });
  assert.equal(state.runs.length, 2);
  release.forEach((fn) => fn());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

// --- status ----------------------------------------------------------------------

test('status reports readiness from the version check and the adapter auth answer', async () => {
  const res = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 'contract');
  assert.equal(body.engine, 'neutral');
  assert.equal(body.engine_version, '', 'no agent binary → no version');
  assert.equal('claude_version' in body, false, 'no alias declared → no alias key');
  assert.equal(body.ready, false);
  assert.equal(body.prompt_timeout_ms, TIMEOUT_MS);
  assert.equal(state.runs.length, 0);
});

function fakeAgent(name, output) {
  const bin = path.join(TMP, name);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
  return bin;
}

async function statusOf(app) {
  const s = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
}

test('status reports the engine version the adapter parses from the agent binary', async () => {
  const body = await statusOf(makeApp({ claudeBin: fakeAgent('neutral-ok', 'neutral-agent 4.5.6 (build 7)') }));
  assert.equal(body.engine, 'neutral');
  assert.equal(body.engine_version, '4.5.6');
  assert.equal(body.version, 'contract', 'version stays the add-on version');
  assert.equal(body.ready, true);
});

test('output the adapter cannot parse, or an unsafe token, is no version', async () => {
  for (const [name, output] of [['neutral-other', 'other-agent 1.0.0'], ['neutral-odd', 'neutral-agent 1.0<script>']]) {
    const body = await statusOf(makeApp({ claudeBin: fakeAgent(name, output) }));
    assert.equal(body.engine_version, '', output);
    assert.equal(body.ready, false, output);
  }
});

test('a declared version alias carries the same value under its own key', async () => {
  const { descriptor } = adapter;
  descriptor.versionAlias = 'neutral_version';
  try {
    const body = await statusOf(makeApp({ claudeBin: fakeAgent('neutral-alias', 'neutral-agent 2.0.1') }));
    assert.equal(body.neutral_version, '2.0.1');
    assert.equal(body.engine_version, '2.0.1');
    const missing = await statusOf(makeApp());
    assert.equal(missing.neutral_version, '');
  } finally {
    delete descriptor.versionAlias;
  }
});

test('request_fields lists exactly the body fields POST /api/prompt accepts', async () => {
  const { request_fields: fields } = await statusOf(makeApp());
  assert.ok(Array.isArray(fields) && fields.length > 0);
  assert.equal(new Set(fields).size, fields.length, 'no duplicates');
  // Every listed field gets past the allowlist: whatever else is wrong with the
  // value, the refusal is never "unknown field".
  for (const field of fields) {
    const res = await post({ prompt: 'hello', [field]: { probe: true } });
    const text = await res.text();
    assert.doesNotMatch(text, /unknown field/, field);
  }
  // Fields that are not listed are refused as unknown, before anything runs.
  const runs = state.runs.length;
  for (const field of ['model', 'engine', 'tools', 'request_fields', 'Prompt']) {
    assert.equal(fields.includes(field), false);
    const res = await post({ prompt: 'hello', [field]: true });
    assert.equal(res.status, 400, field);
    assert.match((await res.json()).error, /unknown field/, field);
  }
  assert.equal(state.runs.length, runs);
});
