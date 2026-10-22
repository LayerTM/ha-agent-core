'use strict';

// The add-on's web options are checked when the prompt API starts: a site that
// is not a public host name turns the web off with one ERROR line, a valid list
// leaves it on.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TEST_HOST, captureLog, reportedPort } = require('../fixtures/bound-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-web-options-'));
const OPTIONS = path.join(TMP, 'options.json');
const TOKEN = 'web-options-token-0123456789abcdef';

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('a web site that is not a public host name turns the web off with one ERROR line; a valid list turns it on', async () => {
  const { useAdapter } = require('../../server/adapter-contract');
  const { createNeutralAdapter } = require('../fixtures/neutral-adapter');
  process.env.CLAUDE_PROMPT_PORT = '0';
  process.env.CLAUDE_PROMPT_HOST = TEST_HOST;
  process.env.CLAUDE_PROMPT_DEV = '1';
  process.env.CLAUDE_PROMPT_DATA = TMP;
  process.env.CLAUDE_PROMPT_OPTIONS = OPTIONS;
  process.env.CLAUDE_PROMPT_SETTINGS = 'neutral-audit-hook';
  process.env.HOME = path.join(TMP, 'home');
  delete process.env.SUPERVISOR_TOKEN;
  const { adapter, branding } = createNeutralAdapter();
  adapter.runner.webCapability = { search: true, fetch: true };
  useAdapter(adapter, branding);
  const promptServer = require('../../server/prompt');
  const statusWeb = async (domains) => {
    fs.writeFileSync(OPTIONS, JSON.stringify({
      prompt_api: true, api_token: TOKEN, ha_token: '', prompt_ha_token: '', chat_web: true, chat_web_domains: domains,
    }));
    const started = await captureLog(() => promptServer.start());
    const port = reportedPort(started.logged.join('\n'), 'prompt server');
    try {
      assert.ok(port, started.logged.join('\n'));
      const res = await fetch(`http://${TEST_HOST}:${port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      return { web: (await res.json()).web, errors: started.logged.filter((l) => /ERROR/.test(l)) };
    } finally {
      started.result();
    }
  };
  const bad = await statusWeb(['example.com', `${['192', '168', '1', '113'].join('.')}.nip.io`]);
  assert.equal(bad.web, null);
  assert.equal(bad.errors.length, 1, JSON.stringify(bad.errors));
  assert.match(bad.errors[0], /web domain "192\.168\.1\.113\.nip\.io" is not a public host name/);
  const good = await statusWeb(['example.com']);
  assert.deepEqual(good.web, { search: true, fetch: true });
  assert.deepEqual(good.errors, []);
});
