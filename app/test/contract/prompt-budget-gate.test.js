'use strict';

// A USD cap is kept only by an engine that reports what a run costs; with any
// other engine the prompt API does not start instead of pretending to enforce it.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-budget-gate-'));
const OPTIONS = path.join(TMP, 'options.json');
const TOKEN = 'budget-gate-token-0123456789abcdef';

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('a daily USD budget starts the prompt API only for an engine that reports cost', async () => {
  const port = await freePort();
  process.env.CLAUDE_PROMPT_PORT = String(port);
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
  const { adapter } = createNeutralAdapter();
  useAdapter(adapter);
  const promptServer = require('../../server/prompt');
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  let stop;
  try {
    stop = await promptServer.start();
  } finally {
    console.log = originalLog;
  }
  assert.equal(typeof stop, 'function');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`), 'nothing listens');
  assert.ok(logged.some((l) => /chat_daily_budget_usd is 2, but neutral does not report what a request costs/.test(l)),
    JSON.stringify(logged));

  adapter.descriptor.reportsCost = true;
  const shutdown = await promptServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).budget, { limit: 2, spent: 0 });
  } finally {
    shutdown();
  }
});
