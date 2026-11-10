'use strict';

// Which reads the HTTP layer offers to a warm session, and what the audit says.
// The run itself is scripted: what is asserted is the `warm` it was handed.

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

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter, okOutcome, errorOutcome } = require('../fixtures/neutral-adapter');

const { adapter, state, run: scriptedRun, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const { createPromptApp } = require('../../server/prompt/server');
const { buildRedactor } = require('../../server/prompt/security');

const TOKEN = 'warm-token-0123456789abcdef';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-warm-'));
const auditLines = [];
const POOL = { neutral: 'pool' };

function makeApp(sessionPool) {
  return createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-such-agent'),
    usageBin: path.join(TMP, 'no-such-usage'),
    haConfigured: true,
    model: 'neutral-model',
    workDir: TMP,
    addonVersion: 'contract',
    redact: buildRedactor([]),
    audit: (line) => auditLines.push(line),
    runAgent: scriptedRun,
    beginRun: async (runId) => ({ token: `bearer-${runId}`, mcpConfigPath: `/run/${runId}/mcp.json`, dir: null }),
    actFor: () => async () => ({ ok: true }),
    sessionPool,
  });
}

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let on;
let off;
before(async () => {
  on = await listen(makeApp(POOL));
  off = await listen(makeApp(null));
});
after(() => {
  for (const s of [on, off]) { s.closeAllConnections(); s.close(); }
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  state.runs.length = 0;
  state.script.length = 0;
  auditLines.length = 0;
});

// A caller per request: the per-caller budget is three in a burst.
let seq = 0;
function post(server, body, caller = `caller-w${seq += 1}`) {
  return fetch(`http://127.0.0.1:${server.address().port}/api/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-claude-caller': caller },
    body: JSON.stringify(body),
  });
}

test('a plain read is offered to the pool with its caller and its own bearer', async () => {
  const res = await post(on, { prompt: 'is the lamp on?' });
  assert.equal(res.status, 200);
  const { warm } = state.runs[0];
  assert.equal(warm.pool, POOL);
  assert.equal(warm.caller, `caller-w${seq}`);
  assert.match(warm.runToken, /^bearer-[0-9a-f]{12}$/);
  assert.doesNotMatch(auditLines.pop(), / warm=1 /, 'a fresh answer is not called warm');
});

test('with the option off nothing is offered', async () => {
  await post(off, { prompt: 'is the lamp on?' });
  assert.equal(state.runs[0].warm, null);
});

test('an automation edit and a retry are never served warm', async () => {
  await post(on, { prompt: 'add a condition', edit_automation: { alias: 'x' } });
  assert.equal(state.runs[0].warm, null, 'an automation edit');

  state.runs.length = 0;
  state.script.push(() => errorOutcome('no-result'), () => okOutcome());
  const res = await post(on, { prompt: 'is the lamp on?' });
  assert.equal(res.status, 200);
  assert.equal(state.runs.length, 2);
  assert.ok(state.runs[0].warm, 'the first attempt may be');
  assert.equal(state.runs[1].warm, null, 'the retry is not');
});

test('an answer from a warm session says so in the audit', async () => {
  state.script.push(() => okOutcome({ warm: true }));
  await post(on, { prompt: 'is the lamp on?' });
  assert.match(auditLines.pop(), /^prompt\[read\] .* warm=1 .*status=200/);
});
