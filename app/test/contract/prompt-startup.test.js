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

test('the bootstrap starts whatever the engine says about its own hooks', async () => {
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
  assert.equal(promptServer.hasAuditHook, undefined, 'the core no longer asks the engine about its hooks');

  // Settings that carry no hook at all: the API starts, because what a chat
  // request does to Home Assistant is recorded by the relay it has to pass.
  process.env.CLAUDE_PROMPT_SETTINGS = 'no hook here';
  const started = await captureLog(() => promptServer.start());
  // Old transcripts are still removed at every start.
  assert.deepEqual(state.removedSessions, [{
    homeDir: path.join(TMP, 'home'), workDir: path.join(TMP, 'claude-prompt', 'work'),
  }]);
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
    // The settings still reach the run unchanged; they are simply no longer a gate.
    assert.equal(state.launches[0].settings, 'no hook here');
  } finally {
    shutdown();
  }
});

test('writeMcpConfig is a per-run call: twice, in two directories, and both hold', async () => {
  // The core calls it once per run, not once per boot, and two runs overlap. An
  // adapter that cached its answer, or wrote to a directory of its own choosing,
  // would hand the second run the first run's bearer — the contract says MAY be
  // called per run and MUST be idempotent, and this is where that is checked.
  const { createNeutralAdapter } = require('../fixtures/neutral-adapter');
  const { adapter } = createNeutralAdapter();
  const dirs = [path.join(TMP, 'run-a'), path.join(TMP, 'run-b')];
  const written = [];
  for (const [i, dir] of dirs.entries()) {
    // eslint-disable-next-line no-await-in-loop
    written.push(await adapter.prompt.writeMcpConfig({ dir, url: `http://127.0.0.1:1/api/mcp`, bearer: `bearer-${i}` }));
  }
  assert.notEqual(written[0], written[1], 'each run is given its own file');
  for (const [i, file] of written.entries()) {
    assert.ok(file.startsWith(dirs[i] + path.sep), `the file is written where the core said (${file})`);
    assert.ok(fs.existsSync(file), 'and the earlier one still exists: writing the second did not disturb it');
  }
  // Called again for the same run, it answers the same way — nothing is consumed.
  const again = await adapter.prompt.writeMcpConfig({ dir: dirs[0], url: 'http://127.0.0.1:1/api/mcp', bearer: 'bearer-0' });
  assert.equal(again, written[0]);
  assert.ok(fs.existsSync(written[0]));
});
