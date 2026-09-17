'use strict';

// Starting the prompt server through its bootstrap, with a neutral adapter: the
// audit gate stays the core's, the adapter writes its MCP config where the core
// says, and a prompt runs through the core's run() and the adapter's agent.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TEST_HOST, captureLog, reportedPort, assertListensOnTestHost, assertPortHeld } = require('../fixtures/bound-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-startup-'));
const OPTIONS = path.join(TMP, 'options.json');
const TOKEN = 'startup-token-0123456789abcdef';

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('the bootstrap refuses to start without the audit hook, then starts with it', async () => {
  // Read by the bootstrap at load time.
  process.env.CLAUDE_PROMPT_PORT = '0';
  process.env.CLAUDE_PROMPT_HOST = TEST_HOST;
  process.env.CLAUDE_PROMPT_DEV = '1';
  process.env.CLAUDE_PROMPT_DATA = TMP;
  process.env.CLAUDE_PROMPT_OPTIONS = OPTIONS;
  process.env.HOME = path.join(TMP, 'home');
  process.env.NEUTRAL_AGENT_KEY = 'neutral-env-secret-0123456789';
  // The neutral agent is a node script; the adapter passes the script itself.
  process.env.CLAUDE_PROMPT_BIN = process.execPath;
  delete process.env.SUPERVISOR_TOKEN;
  fs.writeFileSync(OPTIONS, JSON.stringify({ prompt_api: true, api_token: TOKEN, ha_token: '', prompt_ha_token: '' }));

  const { useAdapter } = require('../../server/adapter-contract');
  const { createNeutralAdapter, okTape } = require('../fixtures/neutral-adapter');
  const { adapter, state, branding } = createNeutralAdapter();
  useAdapter(adapter, branding);
  const promptServer = require('../../server/prompt');
  assert.equal(promptServer.hasAuditHook('neutral-audit-hook'), true, 'the exported check is the adapter\'s');
  assert.equal(promptServer.hasAuditHook('{}'), false);

  // Without the hook: nothing listens, nothing is written.
  process.env.CLAUDE_PROMPT_SETTINGS = 'no hook here';
  const refused = await captureLog(() => promptServer.start());
  assert.equal(typeof refused.result, 'function');
  assert.equal(reportedPort(refused.logged.join('\n'), 'prompt server'), null, 'nothing listens');
  assert.deepEqual(state.mcpConfigs, []);
  // Old transcripts are removed before the gate, whether or not the API starts.
  assert.deepEqual(state.removedSessions, [{
    homeDir: path.join(TMP, 'home'), workDir: path.join(TMP, 'claude-prompt', 'work'),
  }]);

  process.env.CLAUDE_PROMPT_SETTINGS = 'neutral-audit-hook';
  const started = await captureLog(() => promptServer.start());
  const shutdown = started.result;
  const port = reportedPort(started.logged.join('\n'), 'prompt server');
  try {
    assert.ok(port, started.logged.join('\n'));
    assertListensOnTestHost(assert, started.logged.join('\n'), 'prompt server');
    await assertPortHeld(assert, port);
    // No Home Assistant token → no relay → the adapter is told to remove its config.
    assert.deepEqual(state.mcpConfigs, [{ dir: path.join(TMP, 'claude-prompt'), url: '', bearer: '' }]);
    const denied = await fetch(`http://${TEST_HOST}:${port}/api/status`);
    assert.equal(denied.status, 401);
    const res = await fetch(`http://${TEST_HOST}:${port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ha_mcp, false);
    assert.equal(body.ready, false);
    // The adapter's secrets reach the redactor: an echoed secret is not echoed back.
    state.tapes.push(okTape(`key ${process.env.NEUTRAL_AGENT_KEY}`));
    const answer = await fetch(`http://${TEST_HOST}:${port}/api/prompt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'echo' }),
    });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).text, 'key [REDACTED]');
    assert.equal(state.launches[0].settings, 'neutral-audit-hook');
  } finally {
    shutdown();
  }
});
