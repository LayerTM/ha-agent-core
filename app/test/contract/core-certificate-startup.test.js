'use strict';

// What the prompt API's start does with Core's certificate: one it cannot verify
// is raised as a Home Assistant notification through the Supervisor, and the
// `core_certificate_sha256` option pins it.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { TEST_HOST, captureLog } = require('../fixtures/bound-port');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-certificate-'));
const OPTIONS = path.join(TMP, 'options.json');
const NOTICE_URL = 'http://supervisor/core/api/services/persistent_notification/create';

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('an unverified Core certificate raises the notification; pinned by the option it raises none', async () => {
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'core.key'], { cwd: TMP, stdio: 'pipe' });
  execFileSync('openssl', ['req', '-x509', '-new', '-key', 'core.key', '-subj', '/CN=home.example.org', '-days', '2', '-out', 'core.crt'], { cwd: TMP, stdio: 'pipe' });
  const cert = fs.readFileSync(path.join(TMP, 'core.crt'), 'utf8');
  const { fingerprint256 } = new crypto.X509Certificate(cert);

  let asked = 0;
  const core = https.createServer({ cert, key: fs.readFileSync(path.join(TMP, 'core.key')) }, (req, res) => {
    asked += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  await new Promise((r) => { core.listen(0, TEST_HOST, r); });

  Object.assign(process.env, {
    CLAUDE_PROMPT_PORT: '0',
    CLAUDE_PROMPT_HOST: TEST_HOST,
    CLAUDE_PROMPT_DEV: '1',
    CLAUDE_PROMPT_DATA: TMP,
    CLAUDE_PROMPT_OPTIONS: OPTIONS,
    CLAUDE_PROMPT_BIN: process.execPath,
    CLAUDE_PROMPT_SETTINGS: 'no hook here',
    SUPERVISOR_TOKEN: 'certificate-supervisor-token',
    HOME: path.join(TMP, 'home'),
  });

  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://supervisor/')) return realFetch(url, init);
    posted.push({ url: String(url), authorization: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    return new Response('[]', { status: 200 });
  };

  const { useAdapter } = require('../../server/adapter-contract');
  const { createNeutralAdapter } = require('../fixtures/neutral-adapter');
  const { adapter, branding } = createNeutralAdapter();
  useAdapter(adapter, branding);
  require('../../server/prompt/core-target').resolveCoreTarget = async () => (
    { origin: `https://${TEST_HOST}:${core.address().port}`, ssl: true, port: core.address().port, source: 'test' });
  const promptServer = require('../../server/prompt');

  // One start, until the relay's first question to Core has been answered.
  async function startOnce(extra) {
    fs.writeFileSync(OPTIONS, JSON.stringify({
      prompt_api: true, api_token: 'certificate-token-0123456789abcdef', ha_token: 'certificate-ha-token-0123456789', ...extra,
    }));
    const before = asked;
    const started = await captureLog(async () => {
      const shutdown = await promptServer.start();
      const until = Date.now() + 10000;
      while (asked === before && Date.now() < until) await new Promise((r) => { setTimeout(r, 20); });
      return shutdown;
    });
    started.result();
    assert.ok(asked > before, 'the relay reached Core');
  }

  try {
    await startOnce({});
    assert.deepEqual(posted.map((p) => [p.url, p.authorization]), [[NOTICE_URL, 'Bearer certificate-supervisor-token']]);
    assert.ok(posted[0].body.message.includes(fingerprint256));
    posted.length = 0;
    await startOnce({ core_certificate_sha256: fingerprint256 });
    assert.deepEqual(posted, []);
  } finally {
    globalThis.fetch = realFetch;
    core.closeAllConnections();
    core.close();
  }
});
