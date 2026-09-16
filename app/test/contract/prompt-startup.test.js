'use strict';

// Starting the prompt server through its bootstrap, with a neutral adapter: the
// audit gate stays the core's, the adapter writes its MCP config where the core
// says, and shutdown reaches the adapter's runner.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-startup-'));
const OPTIONS = path.join(TMP, 'options.json');
const TOKEN = 'startup-token-0123456789abcdef';

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('the bootstrap refuses to start without the audit hook, then starts with it', async () => {
  const port = await freePort();
  // Read by the bootstrap at load time.
  process.env.CLAUDE_PROMPT_PORT = String(port);
  process.env.CLAUDE_PROMPT_DEV = '1';
  process.env.CLAUDE_PROMPT_DATA = TMP;
  process.env.CLAUDE_PROMPT_OPTIONS = OPTIONS;
  process.env.HOME = path.join(TMP, 'home');
  process.env.NEUTRAL_AGENT_KEY = 'neutral-env-secret-0123456789';
  delete process.env.SUPERVISOR_TOKEN;
  fs.writeFileSync(OPTIONS, JSON.stringify({ prompt_api: true, api_token: TOKEN, ha_token: '', prompt_ha_token: '' }));

  const { useAdapter } = require('../../server/adapter-contract');
  const { createNeutralAdapter } = require('../fixtures/neutral-adapter');
  const { adapter, state } = createNeutralAdapter();
  useAdapter(adapter);
  const promptServer = require('../../server/prompt');
  assert.equal(promptServer.hasAuditHook('neutral-audit-hook'), true, 'the exported check is the adapter\'s');
  assert.equal(promptServer.hasAuditHook('{}'), false);

  // Without the hook: nothing listens, nothing is written.
  process.env.CLAUDE_PROMPT_SETTINGS = 'no hook here';
  const noop = await promptServer.start();
  assert.equal(typeof noop, 'function');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`));
  assert.deepEqual(state.mcpConfigs, []);
  // Old transcripts are removed before the gate, whether or not the API starts.
  assert.deepEqual(state.removedSessions, [{
    homeDir: path.join(TMP, 'home'), workDir: path.join(TMP, 'claude-prompt', 'work'),
  }]);

  process.env.CLAUDE_PROMPT_SETTINGS = 'neutral-audit-hook';
  const shutdown = await promptServer.start();
  try {
    // No Home Assistant token → no relay → the adapter is told to remove its config.
    assert.deepEqual(state.mcpConfigs, [{ dir: path.join(TMP, 'claude-prompt'), url: '', bearer: '' }]);
    const denied = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(denied.status, 401);
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ha_mcp, false);
    assert.equal(body.ready, false);
    // The adapter's secrets reach the redactor: an echoed secret is not echoed back.
    state.script.push(() => ({
      status: 'ok', text: `key ${process.env.NEUTRAL_AGENT_KEY}`, proposal: null, automation: null,
      toolsUsed: [], numTurns: 1, costUsd: 0, tokens: [], truncated: false,
      mcpFailed: false, mcpConnected: null, haTools: null,
    }));
    const answer = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'echo' }),
    });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).text, 'key [REDACTED]');
    assert.equal(state.runs[0].settings, 'neutral-audit-hook');
  } finally {
    shutdown();
  }
  assert.equal(state.shutdowns, 1);
});
