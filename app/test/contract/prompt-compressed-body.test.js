'use strict';

// A gzip-compressed JSON body followed by bytes that are not part of the stream
// must be answered by the error funnel, never left hanging.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter } = require('../fixtures/neutral-adapter');

const { adapter, run, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const { createPromptApp } = require('../../server/prompt/server');
const { buildRedactor } = require('../../server/prompt/security');

const TOKEN = 'contract-token-0123456789abcdef';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-compressed-'));
const ANSWER_MS = 3000;

let server;

before(async () => {
  const app = createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-such-agent'),
    claudeSettings: 'neutral-settings',
    usageBin: path.join(TMP, 'no-such-usage'),
    haConfigured: true,
    model: 'neutral-model',
    workDir: TMP,
    addonVersion: 'contract',
    redact: buildRedactor([]),
    audit: () => {},
    runAgent: run,
    actFor: () => async () => ({ ok: true }),
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function postRaw(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/api/prompt',
      method: 'POST',
      agent: false,
      timeout: ANSWER_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': body.length,
        Authorization: `Bearer ${TOKEN}`,
        'x-claude-caller': 'compressed-body',
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${ANSWER_MS} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

test('a gzip body with trailing bytes gets a 4xx answer, not a hang', async () => {
  const gz = zlib.gzipSync(JSON.stringify({ prompt: 'hello' }));
  const status = await postRaw(Buffer.concat([gz, Buffer.from('trailing bytes after the stream')]));
  assert.ok(status >= 400 && status < 500, `status ${status}`);
});
