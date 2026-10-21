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
// Every action the core carried out in Home Assistant, and how the next ones
// answer: a queue of (basename, args) => answer, then {ok: true}.
const acted = [];
const actScript = [];
const actFor = (runId) => async (basename, args) => {
  acted.push({ runId, basename, args });
  const next = actScript.shift();
  return next ? next(basename, args) : { ok: true };
};

function makeApp(overrides = {}) {
  return createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-such-agent'),
    claudeSettings: 'neutral-settings',
    usageBin: path.join(TMP, 'no-such-usage'),
    haConfigured: true,
    model: 'neutral-model',
    workDir: TMP,
    addonVersion: 'contract',
    redact: buildRedactor([SECRET]),
    audit: (line) => auditLines.push(line),
    runAgent: scriptedRun,
    actFor,
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
  noMcpServer = await listen(makeApp({ haConfigured: false }));
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
  acted.length = 0;
  actScript.length = 0;
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
    [{ body: { mode: 'write', intents: INTENT, memory: [] } }, 400, { error: 'memory is only valid with mode "read"', code: 'mode_mismatch', field: 'memory' }],
    ...[
      { id: 'a' },
      'a fact',
      Array.from({ length: 101 }, (_, i) => ({ id: `f${i}`, text: 'x' })),
    ].map((memory) => [{ body: { prompt: 'x', memory } }, 400, { error: 'memory must be an array of at most 100 facts', code: 'invalid_field', field: 'memory' }]),
    ...[
      ['a fact'],
      [{ id: 'a', text: 'x', user: 'u' }],
    ].map((memory) => [{ body: { prompt: 'x', memory } }, 400, { error: 'each memory fact must be {id, text}', code: 'invalid_field', field: 'memory' }]),
    ...[
      [{ id: '', text: 'x' }],
      [{ id: 'a b', text: 'x' }],
      [{ id: 'x'.repeat(33), text: 'x' }],
      [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }],
    ].map((memory) => [{ body: { prompt: 'x', memory } }, 400, { error: 'each memory id must be a unique 1-32 character [A-Za-z0-9_-] string', code: 'invalid_field', field: 'memory' }]),
    ...[
      [{ id: 'a', text: '   ' }],
      [{ id: 'a', text: 'x'.repeat(201) }],
      [{ id: 'a', text: 7 }],
    ].map((memory) => [{ body: { prompt: 'x', memory } }, 400, { error: 'each memory text must be 1-200 characters', code: 'invalid_field', field: 'memory' }]),
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
  assert.equal(acted.length, 0);
  assert.ok(auditLines.some((line) => line.includes('reason=auto-critical') && line.includes('domains=lock')));
  assert.ok(auditLines.some((line) => line.includes('reason=503-no-mcp')));
});

test('a write is refused while the audit log cannot be written, and a read is not', async () => {
  // The reading is taken where the next action is decided — the same shape as
  // asserting an allocation still EXISTS at the moment it is freed. The happy
  // path is the control: the same request, the same server, the state the only
  // difference.
  let recording = false;
  const app = await listen(makeApp({ auditState: () => (recording ? { recording: true, code: null } : { recording: false, code: 'EROFS' }) }));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    const refused = await post({ mode: 'write', intents: INTENT }, { url });
    assert.equal(refused.status, 503);
    // The code is what a client branches on, and the errno is what a person can
    // act on. `write_unavailable` would have sent a read-only disk to the add-on
    // options to look for a Home Assistant token.
    assert.deepEqual(await refused.json(), {
      error: 'write mode unavailable: the audit log cannot be written, so an action could not be recorded',
      code: 'audit_unavailable',
      audit_error: 'EROFS',
    });
    assert.equal(acted.length, 0, 'the write acted anyway');
    assert.ok(auditLines.some((line) => line.includes('reason=503-no-audit') && line.includes('audit=EROFS')));

    // A read does not act on the home, so the home still answers.
    const read = await post({ prompt: 'what is the temperature?' }, { url });
    assert.equal(read.status, 200);
    assert.equal(state.runs.length, 1);

    // The control: with the record kept, the very same write acts.
    recording = true;
    const allowed = await post({ mode: 'write', intents: INTENT }, { url });
    assert.equal(allowed.status, 200);
    assert.equal(acted.length, 1);
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('status publishes whether the record is being kept, and the errno with it', async () => {
  let state_ = { recording: false, code: 'ENOSPC' };
  const app = await listen(makeApp({ auditState: () => state_ }));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    const failing = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(failing.audit_recording, false);
    assert.equal(failing.audit_error, 'ENOSPC');
    state_ = { recording: true, code: null };
    const kept = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(kept.audit_recording, true);
    assert.equal(kept.audit_error, null);
  } finally {
    app.closeAllConnections();
    app.close();
  }
});


test('a server built without saying whether Home Assistant is configured refuses to start, loudly', () => {
  // Silently falsy would mean every write refused and nothing said; the start's
  // own gates refuse AND name the reason, and so does this.
  assert.throws(() => makeApp({ haConfigured: undefined }), /haConfigured must be true or false/);
});

test('whether Home Assistant is configured is a fact of its own, not the presence of a config file', async () => {
  // The config file is written per run, so between runs there is none while Home
  // Assistant is configured all the same. Nothing may read the path to answer this.
  const server_ = await listen(makeApp({ haConfigured: true }));
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

test('status publishes whether Home Assistant accepts the token, and null without Home Assistant', async () => {
  const states = ['ok', 'unauthorized', 'unreachable', null];
  let now = null;
  const server_ = await listen(makeApp({ haConfigured: true, haMcpAuth: () => now }));
  const url = `http://127.0.0.1:${server_.address().port}`;
  try {
    for (const want of states) {
      now = want;
      // eslint-disable-next-line no-await-in-loop
      const status = await (await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
      assert.equal(status.ha_mcp_auth, want, 'read at the moment of the request');
    }
  } finally {
    server_.close();
  }
  const absent = await (await fetch(`${noMcpBase}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.ok('ha_mcp_auth' in absent, 'the field is always present');
  assert.equal(absent.ha_mcp_auth, null);
});

test('a run gets its own bearer and configuration, and gives both back however it ends', async () => {
  const began = [];
  const ended = [];
  const seenPaths = [];
  const app = makeApp({
    haConfigured: true,
    beginRun: async (runId) => {
      const handle = { token: `bearer-${runId}`, mcpConfigPath: `/run/${runId}/mcp.json`, dir: `/run/${runId}` };
      began.push(handle);
      return handle;
    },
    endRun: async (handle) => { ended.push(handle); },
    runAgent: async (opts) => {
      seenPaths.push(opts.mcpConfigPath);
      if (opts.prompt === 'break') throw new Error('the run died');
      return { status: 'ok', text: 'fine', proposal: null, toolsUsed: [], numTurns: 1 };
    },
  });
  const server_ = await listen(app);
  const url = `http://127.0.0.1:${server_.address().port}`;
  try {
    await post({ mode: 'read', prompt: 'hello' }, { url });
    await post({ mode: 'read', prompt: 'break' }, { url });
  } finally {
    server_.close();
  }
  assert.equal(began.length, 2);
  assert.notEqual(began[0].token, began[1].token, 'a bearer belongs to one run');
  assert.deepEqual(seenPaths, began.map((h) => h.mcpConfigPath), 'a run reads its own configuration');
  assert.deepEqual(ended, began, 'both were given back — the answered run and the one that died');
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
  assert.equal(run.prompt, 'what is on?');
  assert.equal(run.mode, undefined, 'an agent is never told it may act');
  assert.equal(run.intents, undefined);
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

test('remembered facts reach the run normalized, a suggested change comes back, and no fact text is logged', async () => {
  const memory = [{ id: 'a1', text: '  My room is\nthe office. ' }, { id: 'b2', text: 'é'.repeat(200) }];
  const change = { remember: [`Sleep mode is ${SECRET}.`], forget: ['a1'] };
  state.script.push(() => okOutcome({ text: 'Noted.', memoryChange: change }));
  const res = await post({ prompt: 'remember sleep mode', memory });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(state.runs[0].memory, [{ id: 'a1', text: 'My room is the office.' }, { id: 'b2', text: 'é'.repeat(200) }]);
  assert.equal(body.memory_change.remember[0].includes(SECRET), false, 'a new fact is redacted like the answer');
  assert.deepEqual(body.memory_change.forget, ['a1']);
  const line = auditLines.filter((l) => l.startsWith('prompt[read]'))[0];
  assert.match(line, / memory=2 /);
  assert.match(line, / memory_change=\+1-1/);
  assert.ok(auditLines.every((l) => !/office|Sleep mode|é/.test(l)), 'no fact text in the audit log');

  state.script.push(() => okOutcome({ text: 'Noted.', memoryChange: change }));
  const lines = await ndjson(await post({ prompt: 'remember sleep mode', memory, stream: true }));
  assert.deepEqual(lines.pop().memory_change, body.memory_change, 'the done line carries the same change');
});

test('the facts are held to one byte budget, published in status, and a list at the budget is accepted', async () => {
  const res = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const limit = (await res.json()).memory_max_bytes;
  assert.equal(limit, 16 * 1024);
  // 81 full-length facts plus one that ends exactly at the budget; a multibyte script counts its bytes.
  const atLimit = Array.from({ length: 81 }, (_, i) => ({ id: `f${i}`, text: 'ж'.repeat(100) }));
  atLimit.push({ id: 'last', text: 'x'.repeat(limit - 81 * 200) });
  const ok = await post({ prompt: 'x'.repeat(8 * 1024), memory: atLimit });
  assert.equal(ok.status, 200, 'a full prompt with memory at the budget fits the body');
  assert.equal(state.runs.length, 1);
  const over = await post({ prompt: 'x', memory: [...atLimit.slice(0, -1), { id: 'last', text: 'x'.repeat(limit - 81 * 200 + 1) }] });
  assert.equal(over.status, 400);
  assert.deepEqual(await over.json(), {
    error: 'memory too large (max 16 KB of fact text)', code: 'memory_too_large', field: 'memory', limit_bytes: limit,
  });
  assert.equal(state.runs.length, 1, 'refused before anything runs');
});

test('invisible format characters are removed from a fact before it is rendered or checked', async () => {
  const memory = [{ id: 'a1', text: '\u202Eeciffo\u202C \u200Bis\u2066 my\uFEFF room\uD800' }];
  assert.equal((await post({ prompt: 'x', memory })).status, 200);
  assert.deepEqual(state.runs[0].memory, [{ id: 'a1', text: 'eciffo is my room' }]);
  const onlyInvisible = await post({ prompt: 'x', memory: [{ id: 'a1', text: '\u200B\u202E\uFEFF' }] });
  assert.equal(onlyInvisible.status, 400, 'nothing visible left is an empty fact');
});

test('a remembered fact that redaction lengthens past 200 characters is dropped', async () => {
  // A redactor whose marker is longer than the secret it replaces.
  const growing = await listen(makeApp({ redact: (t) => String(t).replace(/k3y/g, '[REDACTED-SECRET]') }));
  try {
    const url = `http://127.0.0.1:${growing.address().port}`;
    const fits = `${'a'.repeat(170)} k3y`;
    const grows = `${'a'.repeat(196)} k3y`;
    state.script.push(() => okOutcome({ text: 'ok', memoryChange: { remember: [grows, fits], forget: [] } }));
    const kept = await (await post({ prompt: 'x', memory: [] }, { url })).json();
    assert.deepEqual(kept.memory_change, { remember: [`${'a'.repeat(170)} [REDACTED-SECRET]`], forget: [] });
    state.script.push(() => okOutcome({ text: 'ok', memoryChange: { remember: [grows], forget: [] } }));
    const none = await (await post({ prompt: 'x', memory: [] }, { url })).json();
    assert.equal('memory_change' in none, false, 'its only fact grew past the bound after redaction');
  } finally {
    growing.closeAllConnections();
    growing.close();
  }
});

test('a read without memory never returns a memory change, and passes none to the run', async () => {
  state.script.push(() => okOutcome({ text: 'ok', memoryChange: { remember: ['A fact.'], forget: [] } }));
  const body = await (await post({ prompt: 'hello' })).json();
  assert.equal(state.runs[0].memory, undefined);
  assert.equal('memory_change' in body, false);
  state.script.push(() => okOutcome({ text: 'ok', memoryChange: null }));
  const empty = await (await post({ prompt: 'hello', memory: [] })).json();
  assert.deepEqual(state.runs[1].memory, []);
  assert.equal('memory_change' in empty, false, 'no change suggested: the key is absent, not null');
  state.script.push(() => okOutcome({ text: 'ok', memoryChange: { remember: ['My room is the office.'], forget: [] } }));
  const first = await (await post({ prompt: 'remember my room is the office', memory: [] })).json();
  assert.deepEqual(first.memory_change, { remember: ['My room is the office.'], forget: [] },
    'an empty list means the client keeps memory and has none yet');
});

test('no delta ends in the middle of a character', async () => {
  // The safety window cuts the answer at length - STREAM_SAFETY_WINDOW (96).
  // This answer puts the two code units of one emoji on either side of that
  // cut: emitted as they fall, the first delta would end in a lone high
  // surrogate and the next begin with its orphaned low half. Neither is text —
  // a strict UTF-8 encoder on the receiving side rejects the line.
  const answer = `${'a'.repeat(10)}\u{1F324}${'b'.repeat(95)}`;
  state.script.push((opts) => {
    opts.onText(answer);
    return okOutcome({ text: answer });
  });
  const res = await post({ prompt: 'emoji on the boundary', stream: true });
  assert.equal(res.status, 200);
  const lines = await ndjson(res);
  const last = lines.pop();
  assert.equal(last.type, 'done');
  assert.equal(last.text, answer);
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    assert.equal(line.type, 'delta');
    assert.ok(line.text.isWellFormed(), `delta is not text: ${JSON.stringify(line.text)}`);
  }
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

test('a camera read killed at init for its tool names is retried once; any other failure of it is not', async () => {
  const http = require('node:http');
  const relay = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const camServer = await listen(makeApp({
    coreRelayUrl: `http://127.0.0.1:${relay.address().port}`,
    beginRun: async () => ({ token: 'relay-token', mcpConfigPath: null, dir: null }),
  }));
  const url = `http://127.0.0.1:${camServer.address().port}`;
  try {
    state.script.push(
      () => errorOutcome('tool-name-mismatch', { toolsUsed: [], haTools: ['ha_GetLiveContext'] }),
      () => okOutcome({ text: 'a person at the door' }),
    );
    const res = await post({ prompt: 'who is at the door?', image_entity: 'camera.door' }, { url });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, 'a person at the door');
    assert.equal(state.runs.length, 2);
    assert.ok(state.runs[0].imagePath && state.runs[1].imagePath, 'both attempts carry the snapshot');
    assert.deepEqual(state.runs[1].haTools, ['ha_GetLiveContext'], 'the retry runs with the learned catalog');
    assert.ok(auditLines.some((line) => line.includes('attempts=2 recovered=tool-name-mismatch')));

    state.runs.length = 0;
    state.script.push(() => errorOutcome('model-error'), () => okOutcome());
    const failed = await post({ prompt: 'who is at the door?', image_entity: 'camera.door' }, { url });
    assert.equal(failed.status, 200);
    assert.equal((await failed.json()).degraded, true);
    assert.equal(state.runs.length, 1, 'a camera read that failed after the model saw the image is not repeated');
  } finally {
    camServer.closeAllConnections();
    camServer.close();
    relay.closeAllConnections();
    relay.close();
  }
});

test('a read that still fails names how every earlier attempt ended', async () => {
  const lineOf = () => auditLines.filter((l) => l.startsWith('prompt[read]')).at(-1);
  auditLines.length = 0;
  state.script.push(() => errorOutcome('model-error'), () => errorOutcome('no-result'));
  await post({ prompt: 'both fail' });
  assert.match(lineOf(), / status=200-degraded reason=no-result attempts=2 retried=model-error turns=/);

  // A run killed at init for its tool names, then refused for its sign-in: the
  // sign-in was met once, and the line says so.
  auditLines.length = 0;
  state.runs.length = 0;
  state.script.push(
    () => errorOutcome('tool-name-mismatch', { toolsUsed: [], haTools: ['ha_GetLiveContext'] }),
    () => errorOutcome('auth-expired'),
  );
  await post({ prompt: 'renamed, then signed out' });
  assert.equal(state.runs.length, 2);
  assert.match(lineOf(), / reason=auth-expired attempts=2 retried=tool-name-mismatch turns=/);

  auditLines.length = 0;
  state.script.push(() => errorOutcome('model-error'), () => okOutcome({ status: 'timeout', text: '' }));
  await post({ prompt: 'then too slow' });
  assert.match(lineOf(), / status=504 retried=model-error dur=/);

  auditLines.length = 0;
  state.script.push(() => errorOutcome('auth-expired'));
  await post({ prompt: 'signed out' });
  assert.match(lineOf(), / reason=auth-expired attempts=1 turns=/);
  assert.doesNotMatch(lineOf(), /retried=/);
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

test('a confirmed write carries out every action itself, in order, and runs no agent', async () => {
  const intents = [
    { intent: 'HassTurnOff', targets: ['switch.heater'], data: {} },
    { intent: 'HassLightSet', targets: ['light.kitchen', 'light.hall'], data: { brightness: 40, name: 'not this' } },
  ];
  const res = await post({ mode: 'write', intents, prompt: 'user words are audit-only' });
  assert.equal(res.status, 200);
  const actions = [
    { intent: 'HassTurnOff', target: 'switch.heater', ok: true },
    { intent: 'HassLightSet', target: 'light.kitchen', ok: true },
    { intent: 'HassLightSet', target: 'light.hall', ok: true },
  ];
  assert.deepEqual(await res.json(), {
    text: '', proposal: null, tools_used: ['HassTurnOff', 'HassLightSet'], truncated: false, actions,
  });
  assert.equal(state.runs.length, 0, 'no agent runs for a write');
  // Each call names exactly its entity: the target, never a name from the data.
  assert.deepEqual(acted.map((a) => [a.basename, a.args]), [
    ['HassTurnOff', { name: 'switch.heater' }],
    ['HassLightSet', { brightness: 40, name: 'light.kitchen' }],
    ['HassLightSet', { brightness: 40, name: 'light.hall' }],
  ]);
  assert.equal(new Set(acted.map((a) => a.runId)).size, 1, 'one run id names every call of one write');
  const line = auditLines.find((l) => l.startsWith('prompt[write] '));
  assert.ok(line, auditLines.join('\n'));
  assert.ok(line.includes(`run=${acted[0].runId} `), line);
  assert.ok(line.includes(' status=200 '), line);
  assert.ok(line.endsWith(' actions=HassTurnOff(switch.heater):ok,HassLightSet(light.kitchen):ok,HassLightSet(light.hall):ok'), line);
  assert.doesNotMatch(line, /cost=|tokens=/, 'a write spends nothing');
});

test('a write in which Home Assistant failed an action answers 502 action_failed, after attempting every one', async () => {
  const intents = [{ intent: 'HassTurnOn', targets: ['light.a', 'light.b', 'light.c'], data: {} }];
  actScript.push(
    () => ({ ok: true }),
    () => ({ ok: false, error: `No entity named light.b (${SECRET})` }),
    () => { throw new Error('the relay went away'); },
  );
  const res = await post({ mode: 'write', intents });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: 'Home Assistant did not carry out every action',
    code: 'action_failed',
    actions: [
      { intent: 'HassTurnOn', target: 'light.a', ok: true },
      { intent: 'HassTurnOn', target: 'light.b', ok: false, error: 'No entity named light.b ([REDACTED])' },
      { intent: 'HassTurnOn', target: 'light.c', ok: false, error: 'the relay went away' },
    ],
  });
  assert.equal(acted.length, 3, 'every action is attempted, and none twice');
  assert.equal(state.runs.length, 0);
  const line = auditLines.find((l) => l.startsWith('prompt[write] '));
  assert.ok(line.includes(' status=502 '), line);
  assert.ok(line.endsWith(' actions=HassTurnOn(light.a):ok,HassTurnOn(light.b):failed,HassTurnOn(light.c):failed'), line);
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

test('status states the core release it is given, and nothing when it has none', async () => {
  const commit = 'a'.repeat(40);
  const stated = await statusOf(makeApp({ core: { version: '9.8.7', commit } }));
  assert.equal(stated.core_version, '9.8.7');
  assert.equal(stated.core_commit, commit);
  const unpacked = await statusOf(makeApp());
  assert.equal(unpacked.core_version, '');
  assert.equal(unpacked.core_commit, '');
});

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
