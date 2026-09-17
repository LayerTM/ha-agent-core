'use strict';

// One request has one wall-clock budget (the core's TIMEOUT_MS) across all its
// attempts. Under a controlled clock: a retry gets exactly what is left after
// the first attempt AND the backoff, and no retry starts once too little is left.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKOFF_MS = 250;
const MIN_RETRY_BUDGET_MS = 1000;
const TIMEOUT_MS = 10000;
// Read by the server at load time.
process.env.CLAUDE_PROMPT_TIMEOUT_MS = String(TIMEOUT_MS);
process.env.CLAUDE_PROMPT_RATE_BURST = '500';
process.env.CLAUDE_PROMPT_RETRY_BACKOFF_MS = String(BACKOFF_MS);
process.env.CLAUDE_PROMPT_MIN_RETRY_BUDGET_MS = String(MIN_RETRY_BUDGET_MS);
process.env.CLAUDE_PROMPT_MAX_ATTEMPTS = '3';

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter, okOutcome, errorOutcome } = require('../fixtures/neutral-adapter');

const { adapter, state, run, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const { createPromptApp } = require('../../server/prompt/server');

const TOKEN = 'deadline-token-0123456789abcdef';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-deadline-'));
let server;
let base;
let clock;
let clockBase = 0;

before(async () => {
  const app = createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-such-agent'),
    usageBin: path.join(TMP, 'no-such-usage'),
    mcpConfigPath: path.join(TMP, 'mcp.json'),
    model: '',
    workDir: TMP,
    addonVersion: 'deadline',
    redact: (text) => text,
    audit: () => {},
    runAgent: run,
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach((t) => {
  state.runs.length = 0;
  state.script.length = 0;
  // Only Date is controlled; timers and sockets keep real time, and the backoff
  // is put on the controlled clock by withBackoffOnClock.
  // It only moves forward, also across tests: the rate limiter was created on
  // real time and must never see the clock go back.
  clockBase = Math.max(Date.now(), clockBase) + 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: clockBase });
  clock = t.mock.timers;
});

// An attempt that takes `elapsed` milliseconds of the controlled clock.
function attempt(elapsed, outcome) {
  return () => {
    clock.tick(elapsed);
    return outcome;
  };
}

function withBackoffOnClock(fn) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => {
    if (ms === BACKOFF_MS) clock.tick(ms);
    return realSetTimeout(cb, ms, ...args);
  };
  return fn().finally(() => { globalThis.setTimeout = realSetTimeout; });
}

function post(prompt) {
  return fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'x-claude-caller': prompt },
    body: JSON.stringify({ prompt }),
  });
}

test('a retry gets exactly the budget left after the first attempt and the backoff', async () => {
  state.script.push(attempt(2000, errorOutcome('model-error')), attempt(0, okOutcome({ text: 'second' })));
  const res = await withBackoffOnClock(() => post('exact'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'second');
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[0].timeoutMs, undefined);
  assert.equal(state.runs[1].timeoutMs, TIMEOUT_MS - 2000 - BACKOFF_MS);
});

test('each further retry gets what is left after every earlier attempt', async () => {
  state.script.push(
    attempt(1000, errorOutcome('no-result')),
    attempt(1500, errorOutcome('no-result')),
    attempt(0, okOutcome()),
  );
  const res = await withBackoffOnClock(() => post('twice'));
  assert.equal(res.status, 200);
  assert.deepEqual(state.runs.map((r) => r.timeoutMs), [
    undefined,
    TIMEOUT_MS - 1000 - BACKOFF_MS,
    TIMEOUT_MS - 1000 - BACKOFF_MS - 1500 - BACKOFF_MS,
  ]);
});

test('no retry starts when the budget left is not more than the minimum', async () => {
  for (const elapsed of [TIMEOUT_MS - MIN_RETRY_BUDGET_MS, TIMEOUT_MS, TIMEOUT_MS + 1]) {
    state.runs.length = 0;
    state.script.push(attempt(elapsed, errorOutcome('model-error')), attempt(0, okOutcome()));
    // eslint-disable-next-line no-await-in-loop
    const res = await withBackoffOnClock(() => post(`spent-${elapsed}`));
    assert.equal(res.status, 200);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await res.json()).degraded, true, `elapsed ${elapsed}`);
    assert.equal(state.runs.length, 1, `elapsed ${elapsed}: retried with too little left`);
    state.script.length = 0;
  }
});

test('one millisecond more than the minimum still earns a retry', async () => {
  const elapsed = TIMEOUT_MS - MIN_RETRY_BUDGET_MS - 1;
  state.script.push(attempt(elapsed, errorOutcome('model-error')), attempt(0, okOutcome()));
  const res = await withBackoffOnClock(() => post('just-enough'));
  assert.equal(res.status, 200);
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[1].timeoutMs, TIMEOUT_MS - elapsed - BACKOFF_MS);
});

test('a retry whose budget ran out during the backoff is handed zero, never a fresh budget', async () => {
  // Remaining before the backoff: MIN + 1 (retry allowed); after it: MIN + 1 - BACKOFF.
  // With a backoff longer than what is left, the handed budget clamps at zero.
  const elapsed = TIMEOUT_MS - MIN_RETRY_BUDGET_MS - 1;
  state.script.push(attempt(elapsed, errorOutcome('model-error')), attempt(0, okOutcome()));
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => {
    if (ms === BACKOFF_MS) clock.tick(TIMEOUT_MS);
    return realSetTimeout(cb, ms, ...args);
  };
  try {
    const res = await post('late');
    assert.equal(res.status, 200);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[1].timeoutMs, 0);
});
