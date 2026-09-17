'use strict';

// A USD cap is kept only by an engine that reports what a run costs; with any
// other engine the prompt API does not start instead of pretending to enforce it.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TEST_HOST, captureLog, reportedPort, assertPortHeld } = require('../fixtures/bound-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-budget-gate-'));
const OPTIONS = path.join(TMP, 'options.json');
const TOKEN = 'budget-gate-token-0123456789abcdef';

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('a daily USD budget starts the prompt API only for an engine that reports cost', async () => {
  process.env.CLAUDE_PROMPT_PORT = '0';
  process.env.CLAUDE_PROMPT_HOST = TEST_HOST;
  process.env.CLAUDE_PROMPT_DEV = '1';
  process.env.CLAUDE_PROMPT_DATA = TMP;
  process.env.CLAUDE_PROMPT_OPTIONS = OPTIONS;
  process.env.CLAUDE_PROMPT_SETTINGS = 'neutral-audit-hook';
  process.env.HOME = path.join(TMP, 'home');
  delete process.env.SUPERVISOR_TOKEN;
  fs.writeFileSync(OPTIONS, JSON.stringify({
    prompt_api: true, api_token: TOKEN, ha_token: '', prompt_ha_token: '', chat_daily_budget_usd: 2,
  }));

  const { useAdapter } = require('../../server/adapter-contract');
  const { createNeutralAdapter } = require('../fixtures/neutral-adapter');
  const { adapter, branding } = createNeutralAdapter();
  useAdapter(adapter, branding);
  const promptServer = require('../../server/prompt');
  const { result: stop, logged } = await captureLog(() => promptServer.start());
  assert.equal(typeof stop, 'function');
  assert.equal(reportedPort(logged.join('\n'), 'prompt server'), null, 'nothing listens');
  assert.ok(logged.some((l) => /chat_daily_budget_usd is 2, but neutral does not report what a request costs/.test(l)),
    JSON.stringify(logged));

  adapter.descriptor.reportsCost = true;
  const started = await captureLog(() => promptServer.start());
  const shutdown = started.result;
  const port = reportedPort(started.logged.join('\n'), 'prompt server');
  try {
    assert.ok(port, started.logged.join('\n'));
    await assertPortHeld(assert, port);
    const res = await fetch(`http://${TEST_HOST}:${port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).budget, { limit: 2, spent: 0 });
  } finally {
    shutdown();
  }
});
