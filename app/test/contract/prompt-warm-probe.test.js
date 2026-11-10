'use strict';

// A warm read makes no request to Home Assistant, so nothing in it can show that
// Home Assistant has stopped accepting the token. What the server may know is
// the relay's cached answer, which is as old as the last request. So before a
// read is offered to a warm session the server asks Home Assistant now (the
// relay's own probe), and a session is used only if the answer is 'ok'.
//
// The relay, the stub Home Assistant and the server are real; the pool and the
// agent are scripted, but the pool decides as the real one does: through the
// relay's `mcpUsable`, which is what the probe just refreshed.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.CLAUDE_PROMPT_RATE_BURST = '500';
process.env.CLAUDE_PROMPT_TIMEOUT_MS = '10000';

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter, okOutcome } = require('../fixtures/neutral-adapter');

const { adapter, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const { createPromptApp } = require('../../server/prompt/server');
const { startCoreRelay } = require('../../server/prompt/core-relay');
const { buildRedactor } = require('../../server/prompt/security');

const TOKEN = 'warm-probe-token-0123456789abcdef';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-warm-probe-'));
const MCP_INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';

let answer = 200; // what the stub Home Assistant answers the token with
let core;
let relay;
let server;
let seq = 0;
const auditLines = [];
const served = []; // 'warm' | 'fresh', per read

before(async () => {
  core = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (answer !== 200) { res.writeHead(answer, { 'content-type': 'text/plain' }); res.end('no'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  relay = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${core.address().port}`, haToken: 'ha-token', log: () => {}, authProbeEveryMs: 0,
  });

  // A pool whose one session is always ready; it serves a turn only when the
  // relay says Home Assistant accepts the connection, as the real pool's hook does.
  const pool = {
    take() {
      if (!relay.mcpUsable()) return null;
      return { end() {} };
    },
  };
  // The agent: a warm turn answers at once and asks Home Assistant nothing; a
  // fresh run asks it, with its own bearer, as a real agent's tools do.
  const runAgent = async (opts) => {
    const turn = opts.warm && opts.warm.pool.take('key', opts.warm.runToken);
    if (turn) { served.push('warm'); return okOutcome({ text: 'a guess', warm: true }); }
    served.push('fresh');
    await fetch(`${relay.url}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.warm.runToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: MCP_INIT,
    });
    return okOutcome({ text: 'a guess' });
  };
  const app = createPromptApp({
    token: TOKEN,
    claudeBin: path.join(TMP, 'no-such-agent'),
    usageBin: path.join(TMP, 'no-such-usage'),
    haConfigured: true,
    model: 'neutral-model',
    workDir: TMP,
    addonVersion: 'contract',
    redact: buildRedactor([]),
    audit: (line) => auditLines.push(line),
    runAgent,
    beginRun: async (runId) => ({ token: relay.issue(runId, { basenames: ['GetLiveContext'] }), mcpConfigPath: '/run/mcp.json', dir: null }),
    endRun: async (run) => { if (run && run.token) relay.revoke(run.token); },
    actFor: () => async () => ({ ok: true }),
    haMcpAuth: () => relay.mcpAuth(),
    probeHa: () => relay.probeAuth(),
    tokenRefusal: (runId) => relay.tokenRefusal(runId),
    sessionPool: pool,
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
});
after(() => {
  server.closeAllConnections();
  server.close();
  relay.close();
  core.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  auditLines.length = 0;
  served.length = 0;
});

async function read() {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-claude-caller': `caller-p${seq += 1}` },
    body: JSON.stringify({ prompt: 'is the lamp on?', language: 'en' }),
  });
  return { status: res.status, body: await res.json() };
}

test('Home Assistant accepting the token: the read is served warm', async () => {
  answer = 200;
  await relay.probeAuth();
  assert.equal(relay.mcpAuth(), 'ok');
  const { body } = await read();
  assert.deepEqual(served, ['warm']);
  assert.equal(body.text, 'a guess');
});

for (const status of [401, 403]) {
  test(`the cached answer is 'ok' but Home Assistant now answers ${status}: the read is not warm and is judged refused`, async () => {
    answer = 200;
    await relay.probeAuth();
    assert.equal(relay.mcpAuth(), 'ok', 'the cached answer is the stale one');
    answer = status;
    const { status: http200, body } = await read();
    assert.deepEqual(served, ['fresh']);
    assert.equal(http200, 200);
    assert.equal(body.degraded, true);
    assert.equal(body.reason, 'ha-token-refused');
    assert.match(auditLines.pop(), /status=200-degraded reason=ha-token-refused /);
    answer = 200;
  });
}
