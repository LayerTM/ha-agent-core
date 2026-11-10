'use strict';

// A warm session's bearer (core-relay.js): it means the run it is serving now,
// and between turns it may only start and list its tools.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCoreRelay } = require('../server/prompt/core-relay');

let core;
let relay;
let seen;
const logged = [];

before(async () => {
  core = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url.startsWith('/api/camera_proxy/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end('jpeg');
        return;
      }
      let id = null;
      try { id = JSON.parse(Buffer.concat(chunks).toString('utf8')).id ?? null; } catch { /* not JSON */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  relay = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${core.address().port}`, haToken: 'ha-token', log: (m) => logged.push(m),
  });
});

after(() => {
  relay.close();
  core.close();
});

const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
const CALL = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"GetLiveContext","arguments":{}}}';

function post(token, body) {
  return fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
  });
}
function camera(token, entity) {
  return fetch(`${relay.url}/api/camera_proxy/${entity}`, { headers: { authorization: `Bearer ${token}` } });
}

test('between turns a session may start, and may not call a tool or read a camera', async () => {
  const session = relay.issueSession({ basenames: ['GetLiveContext'] });
  seen = [];
  logged.length = 0;
  assert.equal((await post(session, INIT)).status, 200, 'starting is not reading the house');
  const call = await post(session, CALL);
  assert.equal(call.status, 401);
  assert.equal((await camera(session, 'camera.door')).status, 401);
  assert.deepEqual(seen.map((r) => r.body), [INIT], 'only the start reached Home Assistant');
  assert.equal(logged.filter((l) => /between turns/.test(l)).length, 2, logged.join('\n'));
  relay.revokeSession(session);
});

test('a bound session acts as its run, and only for as long as the turn lasts', async () => {
  const session = relay.issueSession({ basenames: ['GetLiveContext'] });
  const runA = relay.issue('run-a', { basenames: ['GetLiveContext'], cameras: ['camera.door'] });
  const runB = relay.issue('run-b', { basenames: ['GetLiveContext'], cameras: [] });
  seen = [];
  assert.equal(relay.bindSession(session, runA), true);
  assert.equal((await post(session, CALL)).status, 200, 'the turn may call what its run may');
  assert.equal((await camera(session, 'camera.door')).status, 200, 'and read its camera');
  relay.unbindSession(session);
  assert.equal((await post(session, CALL)).status, 401, 'unbound again at the end of the turn');

  // The next turn is another run, with no camera: turn A's camera is not lent on.
  assert.equal(relay.bindSession(session, runB), true);
  assert.equal((await camera(session, 'camera.door')).status, 404);
  assert.equal((await post(session, CALL)).status, 200);
  // A run that ends takes its session back to between turns.
  relay.revoke(runB);
  assert.equal((await post(session, CALL)).status, 401);
  assert.equal(relay.bindSession(session, runB), false, 'an ended run cannot be bound');

  relay.revokeSession(session);
  assert.equal((await post(session, INIT)).status, 401, 'a revoked session is unknown');
  relay.revoke(runA);
});
