'use strict';

// What an engine may or may not report — account limits, the cost of a run, the
// shape of its credentials — and what the HTTP contract says in each case.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CLAUDE_PROMPT_RATE_BURST = '500';
process.env.CLAUDE_PROMPT_TIMEOUT_MS = '10000';

const contract = require('../../server/adapter-contract');
const { createNeutralAdapter, okOutcome } = require('../fixtures/neutral-adapter');

const { adapter, state, run } = createNeutralAdapter();
contract.useAdapter(adapter);

const { createPromptApp } = require('../../server/prompt/server');
const { buildRedactor } = require('../../server/prompt/security');

const TOKEN = 'reports-token-0123456789abcdef';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-reports-'));
const auditLines = [];
const fetchStub = async () => { throw new Error('the adapter decides what is fetched'); };

function makeApp(overrides = {}) {
  return createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-agent'),
    usageBin: path.join(TMP, 'no-usage'),
    mcpConfigPath: null,
    model: '',
    workDir: TMP,
    addonVersion: 'reports',
    redact: (s) => s,
    audit: (line) => auditLines.push(line),
    apiKey: 'api-key-value',
    oauthToken: 'oauth-token-value',
    homeDir: '/home/test',
    limitsFetch: fetchStub,
    runAgent: run,
    ...overrides,
  });
}

let server;
let base;

before(async () => {
  server = await new Promise((resolve) => { const s = makeApp().listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  state.limits = null;
  state.limitsAsked.length = 0;
  state.limitsRead.length = 0;
  auditLines.length = 0;
  delete adapter.descriptor.reportsCost;
});

async function get(route, url = base) {
  const res = await fetch(`${url}${route}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: await res.json() };
}

async function freshApp() {
  const s = await new Promise((resolve) => { const x = makeApp().listen(0, '127.0.0.1', () => resolve(x)); });
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() };
}

const ENTRY = { kind: 'five_hour', percent: 42, severity: null, resets_at: '2026-09-17T10:00:00Z', model: null };

// --- account limits ---------------------------------------------------------------

test('without a credential there is nothing to report', async () => {
  const r = await get('/api/account_limits');
  assert.equal(r.status, 503);
  assert.deepEqual(state.limitsAsked, [{ apiKey: 'api-key-value', oauthToken: 'oauth-token-value', homeDir: '/home/test' }]);
});

test('a credential without limits reports its mode and an empty list', async () => {
  state.limits = { mode: 'api_key', key: 'k' };
  const r = await get('/api/account_limits');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'api_key');
  assert.deepEqual(r.body.limits, []);
  assert.match(r.body.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('limits are read through the adapter with the injected fetch, and cached per credential', async () => {
  const app = await freshApp();
  try {
    state.limits = { mode: 'subscription', key: 'account-a', entries: [ENTRY] };
    const first = await get('/api/account_limits', app.url);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.limits, [ENTRY]);
    assert.equal(first.body.mode, 'subscription');
    assert.equal(state.limitsRead.length, 1);
    assert.equal(state.limitsRead[0], fetchStub);
    await get('/api/account_limits', app.url);
    assert.equal(state.limitsRead.length, 1, 'served from the cache');
    state.limits = { mode: 'subscription', key: 'account-b', entries: [{ ...ENTRY, percent: 7 }] };
    const other = await get('/api/account_limits', app.url);
    assert.equal(other.body.limits[0].percent, 7, 'another credential is never served the first one\'s figures');
    assert.equal(state.limitsRead.length, 2);
  } finally {
    app.close();
  }
});

test('anything that is not a contract entry makes the report unavailable', async () => {
  const bad = [
    null, 'x', { ...ENTRY, kind: '' }, { ...ENTRY, percent: 42.5 }, { ...ENTRY, percent: 101 }, { ...ENTRY, percent: -1 },
    { ...ENTRY, severity: 3 }, { ...ENTRY, resets_at: 1 }, { ...ENTRY, model: {} },
  ];
  for (const [i, entry] of bad.entries()) {
    const app = await freshApp();
    try {
      state.limits = { mode: 'subscription', key: `bad-${i}`, entries: [ENTRY, entry] };
      assert.equal((await get('/api/account_limits', app.url)).status, 503, JSON.stringify(entry));
    } finally {
      app.close();
    }
  }
  const cases = [
    { mode: 'subscription', key: 'n', entries: null },
    { mode: 'subscription', key: 't', entries: () => { throw new Error('upstream down'); } },
    { mode: 'Sub scription', key: 'm', entries: [ENTRY] },
    { throws: true },
  ];
  for (const limits of cases) {
    const app = await freshApp();
    try {
      state.limits = limits;
      assert.equal((await get('/api/account_limits', app.url)).status, 503, JSON.stringify(limits));
    } finally {
      app.close();
    }
  }
});

// --- cost -----------------------------------------------------------------------

test('an engine that does not report cost publishes no budget and audits the cost as unknown', async () => {
  const status = await get('/api/status');
  assert.equal('budget' in status.body, false);
  state.script.push(() => okOutcome({ costUsd: null, tokens: [{ model: 'm', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] }));
  const res = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assert.equal(res.status, 200);
  assert.match(auditLines.at(-1), / tokens=m:1:2:0:0 cost=unknown$/);
});

test('an engine that reports cost publishes the budget and bills every run', async () => {
  adapter.descriptor.reportsCost = true;
  const app = createPromptApp({
    token: TOKEN, claudeBin: path.join(TMP, 'no-agent'), usageBin: path.join(TMP, 'no-usage'), mcpConfigPath: null,
    model: '', workDir: TMP, addonVersion: 'reports', redact: (s) => s, audit: (l) => auditLines.push(l),
    dailyBudgetUsd: 5, runAgent: run,
  });
  const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    state.script.push(() => okOutcome({ costUsd: 0.25 }));
    const res = await fetch(`${url}/api/prompt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    assert.equal(res.status, 200);
    assert.match(auditLines.at(-1), / cost=\$0\.2500$/);
    assert.deepEqual((await get('/api/status', url)).body.budget, { limit: 5, spent: 0.25 });
  } finally {
    s.close();
  }
});

// --- credentials ------------------------------------------------------------------

// Credential-shaped strings, assembled here so the file itself holds none.
const JWT_LIKE = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIx', 'c2lnbmF0dXJl'].join('.');
const VENDOR_KEY_LIKE = ['sk', 'ant', 'api03', 'abcdefghijkl'].join('-');

test('the engine\'s credential shapes are redacted next to the generic ones', () => {
  const redact = buildRedactor(['exact-secret-value'], adapter.prompt.secretPatterns);
  assert.equal(
    redact(`neutral-key-ABCDEFGH1234 and ${JWT_LIKE} and exact-secret-value`),
    '[REDACTED] and [REDACTED] and [REDACTED]',
  );
  // An engine's shape is not the core's: without the adapter's list it stays.
  assert.equal(buildRedactor([])('neutral-key-ABCDEFGH1234'), 'neutral-key-ABCDEFGH1234');
  assert.equal(buildRedactor([])(VENDOR_KEY_LIKE), VENDOR_KEY_LIKE);
});

test('the credential shapes must be global regular expressions', () => {
  const withPatterns = (secretPatterns) => ({ ...adapter, prompt: { ...adapter.prompt, secretPatterns } });
  assert.doesNotThrow(() => contract.validateAdapter(withPatterns([])));
  for (const bad of [[/x/], ['x'], /x/g, {}]) {
    assert.throws(() => contract.validateAdapter(withPatterns(bad)), /prompt\.secretPatterns/, String(bad));
  }
  const { secretPatterns, ...prompt } = adapter.prompt;
  assert.ok(secretPatterns);
  assert.doesNotThrow(() => contract.validateAdapter({ ...adapter, prompt }), 'the list is optional');
  assert.throws(() => contract.validateAdapter({ ...adapter, descriptor: { ...adapter.descriptor, reportsCost: 'yes' } }),
    /descriptor\.reportsCost must be a boolean/);
});
