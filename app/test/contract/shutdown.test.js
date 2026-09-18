'use strict';

// What the bootstrap hands back must be able to end everything it started. The
// prompt server and, when Home Assistant is configured, the relay both listen on
// a socket; if one survives `shutdown()`, the process it runs in never exits —
// a service that restarts on an options change would pile a dead listener onto
// every restart, and any suite that starts the server hangs instead of finishing.
//
// Two cycles, not one, because the second start is where a listener held by the
// first would show: the leak this guards against is per start, and a single
// cycle can look clean while the handle count grows.
//
// The check is the process's own view of what is still open. `node --test` runs
// each file in its own process, so a listening handle seen here belongs to this
// file. A server whose `close()` has been called reports `listening === false`
// immediately, so no waiting is involved.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TEST_HOST, captureLog } = require('../fixtures/bound-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-shutdown-'));
const OPTIONS = path.join(TMP, 'options.json');
const TOKEN = 'shutdown-token-0123456789abcdef';

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function listeningServers() {
  // @ts-ignore -- the handle list is the only place that names what is still bound
  return process._getActiveHandles().filter((h) => h && h.listening === true);
}

test('the shutdown the bootstrap returns releases every listener it opened', async () => {
  process.env.CLAUDE_PROMPT_PORT = '0';
  process.env.CLAUDE_PROMPT_HOST = TEST_HOST;
  process.env.CLAUDE_PROMPT_DEV = '1';
  process.env.CLAUDE_PROMPT_DATA = TMP;
  process.env.CLAUDE_PROMPT_OPTIONS = OPTIONS;
  process.env.HOME = path.join(TMP, 'home');
  process.env.NEUTRAL_AGENT_KEY = 'neutral-env-secret-0123456789';
  process.env.CLAUDE_PROMPT_BIN = process.execPath;
  process.env.CLAUDE_PROMPT_SETTINGS = 'no hook here';
  delete process.env.SUPERVISOR_TOKEN;

  const { useAdapter } = require('../../server/adapter-contract');
  const { createNeutralAdapter } = require('../fixtures/neutral-adapter');
  const { adapter, branding } = createNeutralAdapter();
  useAdapter(adapter, branding);
  const promptServer = require('../../server/prompt');

  assert.deepEqual(listeningServers(), [], 'nothing is listening before the first start');

  // Both shapes: with Home Assistant configured there is a relay listening
  // beside the prompt server, and both are the bootstrap's to end.
  for (const haToken of ['', 'shutdown-ha-token-0123456789']) {
    fs.writeFileSync(OPTIONS, JSON.stringify({
      prompt_api: true, api_token: TOKEN, ha_token: haToken, prompt_ha_token: haToken,
    }));
    // eslint-disable-next-line no-await-in-loop
    const started = await captureLog(() => promptServer.start());
    const expected = haToken ? 2 : 1;
    assert.equal(listeningServers().length, expected,
      `${expected} listener(s) expected while running (ha_token: ${haToken ? 'set' : 'empty'})`);
    started.result();
    assert.deepEqual(listeningServers().map((s) => s.address()), [],
      `a listener survived shutdown (ha_token: ${haToken ? 'set' : 'empty'})`);
  }
});
