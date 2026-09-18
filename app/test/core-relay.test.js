'use strict';

// Tests for core-relay.js — the loopback hop that holds the Home Assistant token
// and owns how Core is reached (ClaudeInHA#47).
//
// Driven against a stub "Core" so the assertions are about the relay's own
// behaviour: what it forwards, what it refuses, what it never leaks.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCoreRelay } = require('../server/prompt/core-relay');

// What a run under test was allowed: the tool basenames these tests call and the
// camera they read. A bearer carries its run's permission (see issue()), so a
// fixture has to state it — a token issued with nothing may call nothing, which
// is what the gate tests below rely on.
const MAY = Object.freeze({
  basenames: ['HassTurnOn', 'HassTurnOff', 'Answered', 'Silent', 'GetLiveContext'],
  cameras: ['camera.front_door', 'camera.missing', 'camera.moved', 'camera.silent'],
});

const HA_TOKEN = 'ha-llat-must-never-leave-the-relay';
// The bearer is minted per run by the relay itself; a test holds the one it issued.
let RELAY_TOKEN;

let core;          // stub Core
let coreOrigin;
let seen;          // requests the stub Core received
let relay;

before(async () => {
  core = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/api/redirect-me') {
        res.writeHead(302, { location: 'http://elsewhere.invalid/api/mcp' });
        res.end();
        return;
      }
      if (req.url === '/api/mcp' && req.headers.accept === 'text/event-stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.write('event: one\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"n":1}}\n\n');
        setTimeout(() => {
          res.write('event: two\ndata: {"jsonrpc":"2.0","id":7,"result":{"n":2}}\n\n');
          res.end();
        }, 20);
        return;
      }
      let id = null;
      try { id = JSON.parse(Buffer.concat(chunks).toString('utf8')).id ?? null; } catch { /* not JSON */ }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { path: req.url } }));
    });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  coreOrigin = `http://127.0.0.1:${core.address().port}`;
  seen = [];
  relay = await startCoreRelay({ coreOrigin, haToken: HA_TOKEN });
  RELAY_TOKEN = relay.issue('run-under-test', MAY);
  auth = { authorization: `Bearer ${RELAY_TOKEN}` };
});

after(() => {
  relay.close();
  core.close();
});

// Set once the relay exists, because only the relay can mint a bearer.
let auth;
const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';

test('binds loopback only', () => {
  assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('swaps the relay token for the HA token, and never forwards the relay one', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: INIT,
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${HA_TOKEN}`);
  assert.ok(!JSON.stringify(seen[0].headers).includes(RELAY_TOKEN),
    'the relay token must not reach Core');
  assert.equal(seen[0].body, INIT, 'request body is forwarded intact');
});

test('a wrong bearer is refused and nothing reaches Core', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}',
  });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0);
});

test('no bearer at all is refused', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0);
});

// The allowlist is the reason a disabled certificate check is safe here: there
// is no path through this relay to an arbitrary Core endpoint, let alone another
// host.
const refused = [
  ['unknown path', 'GET', '/api/states'],
  ['config endpoint', 'GET', '/api/config'],
  ['MCP with a disallowed method', 'PUT', '/api/mcp'],
  ['path traversal out of the camera prefix', 'GET', '/api/camera_proxy/../states'],
  ['camera path with a bad entity', 'GET', '/api/camera_proxy/notacamera'],
  ['root', 'GET', '/'],
];

for (const [name, method, p] of refused) {
  test(`refuses: ${name}`, async () => {
    seen = [];
    const res = await fetch(`${relay.url}${p}`, { method, headers: auth });
    assert.equal(res.status, 404, `${method} ${p} must not be relayed`);
    assert.equal(seen.length, 0, 'nothing may reach Core');
  });
}

test('camera snapshots are allowed and carry the HA token', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/camera_proxy/camera.front_door`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/api/camera_proxy/camera.front_door');
  assert.equal(seen[0].headers.authorization, `Bearer ${HA_TOKEN}`);
});

test('mcp-session-id survives in both directions', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { ...auth, 'mcp-session-id': 'sess-1', 'mcp-protocol-version': '2026-03-26' },
    body: INIT,
  });
  assert.equal(seen[0].headers['mcp-session-id'], 'sess-1');
  assert.equal(seen[0].headers['mcp-protocol-version'], '2026-03-26');
  assert.equal(res.headers.get('mcp-session-id'), 'sess-1');
});

test('server-sent events stream through rather than being buffered', async () => {
  seen = [];
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { ...auth, accept: 'text/event-stream' }, body: INIT,
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const first = await reader.read();
  // The stub holds the second event back by 20ms; receiving the first before the
  // response ends is what proves the relay is piping and not accumulating.
  assert.match(Buffer.from(first.value).toString('utf8'), /event: one/);
  await reader.cancel();
});

test('a 3xx from Core becomes a 502 and the Authorization header is not re-sent', async () => {
  // A stub Core that redirects everything, including /api/mcp.
  const redirecting = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://elsewhere.invalid/api/mcp' });
    res.end();
  });
  await new Promise((r) => redirecting.listen(0, '127.0.0.1', r));
  const r2 = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${redirecting.address().port}`,
    haToken: HA_TOKEN,
  });
  try {
    const res = await fetch(`${r2.url}/api/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${r2.issue('run-2', MAY)}` }, body: INIT,
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /redirect/);
  } finally {
    r2.close();
    redirecting.close();
  }
});

test('an unreachable Core is a 502, not an auth error', async () => {
  const dead = await startCoreRelay({
    coreOrigin: 'http://127.0.0.1:1',   // nothing listens here
    haToken: HA_TOKEN,
  });
  try {
    const res = await fetch(`${dead.url}/api/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${dead.issue('run-3', MAY)}` }, body: INIT,
    });
    assert.equal(res.status, 502, 'unreachable must never present as 401');
  } finally {
    dead.close();
  }
});

test('a bearer belongs to one run: two runs get two, and a revoked one is refused', async () => {
  const a = relay.issue('run-a', MAY);
  const b = relay.issue('run-b', MAY);
  assert.notEqual(a, b, 'two runs never share a bearer');
  for (const t of [a, b]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${relay.url}/api/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: INIT,
    });
    assert.equal(res.status, 200, 'an issued bearer passes');
  }
  relay.revoke(a);
  const revoked = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${a}`, 'content-type': 'application/json' }, body: INIT,
  });
  assert.equal(revoked.status, 401, 'the run ended, so its bearer opens nothing');
  const other = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${b}`, 'content-type': 'application/json' }, body: INIT,
  });
  assert.equal(other.status, 200, 'and the run still in flight is untouched');
  relay.revoke(b);
});

test('a bearer nobody issued is refused, and so is one from a closed relay', async () => {
  const res = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer never-issued' }, body: INIT,
  });
  assert.equal(res.status, 401);
  const other = await startCoreRelay({ coreOrigin, haToken: HA_TOKEN });
  const token = other.issue('run-elsewhere', MAY);
  const mine = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: INIT,
  });
  assert.equal(mine.status, 401, "one relay's bearer is nothing to another");
  other.close();
});

// --- the record the relay writes -------------------------------------------

// A Core that answers a tools/call however the test asks, and a relay that
// records into an array instead of the audit log.
async function withRecording(answerFor) {
  const lines = [];
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let sent = null;
      try { sent = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
      const answer = sent ? answerFor(sent) : null;
      if (answer === null) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const relayHere = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${fake.address().port}`, haToken: HA_TOKEN, record: (line) => lines.push(line),
  });
  return {
    lines,
    relay: relayHere,
    async call(token, message) {
      return fetch(`${relayHere.url}/api/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
    },
    done() { relayHere.close(); fake.close(); },
  };
}

const ok = (sent) => ({ jsonrpc: '2.0', id: sent.id, result: { content: [{ type: 'text', text: 'done' }] } });

test('every tool call a run makes is recorded once, with its tool, its run and its arguments', async () => {
  const h = await withRecording(ok);
  try {
    const token = h.relay.issue('run-7', MAY);
    await h.call(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await h.call(token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'HassTurnOn', arguments: { name: 'desk lamp' } },
    });
    assert.deepEqual(h.lines, ['HassTurnOn run=run-7: {"name":"desk lamp"}'], 'the call, and nothing that is not one');
  } finally {
    h.done();
  }
});

test('an argument cannot forge a line of its own, and a long one is cut', async () => {
  const h = await withRecording(ok);
  try {
    // The tool NAME is the vector: the arguments are JSON, which escapes a
    // newline into two characters, but a name is written as it arrives. The run
    // is ALLOWED this tool, so the line is about the record and not about the
    // gate: a refused call would never be recorded at all.
    const forged = 'Hass\n2026-01-01 00:00:00  prompt[read] caller=x status=200 tokens=evil:9:0:0:0 cost=$9.9999';
    const token = h.relay.issue('run-8', { basenames: [forged] });
    await h.call(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: forged, arguments: { pad: 'y'.repeat(400) } },
    });
    assert.equal(h.lines.length, 1);
    assert.ok(!h.lines[0].includes('\n'), 'no newline reaches the log, so no second line can be forged');
    assert.ok(Buffer.byteLength(h.lines[0], 'utf8') <= 1000);
    assert.ok(h.lines[0].startsWith('Hass 2026-01-01'), `the control character became a space: ${h.lines[0]}`);
    // The arguments are cut, and the cut is in the arguments, not in what names
    // the run — a record that loses its run id records nothing.
    assert.ok(h.lines[0].includes('run=run-8'));
    assert.ok(h.lines[0].endsWith('y'), 'the arguments are cut at the cap');
  } finally {
    h.done();
  }
});

test('a preview is told from a change, and a refusal from both', async () => {
  const h = await withRecording((sent) => {
    if (sent.params && sent.params.name === 'Failing') {
      return { jsonrpc: '2.0', id: sent.id, error: { code: -32000, message: 'no' } };
    }
    if (sent.params && sent.params.name === 'PreviewInAnswer') {
      return { jsonrpc: '2.0', id: sent.id, result: { content: [{ type: 'text', text: '{"dry_run": true}' }] } };
    }
    return ok(sent);
  });
  try {
    const token = h.relay.issue('run-9', { basenames: ['PreviewInArgs', 'PreviewInAnswer', 'Failing', 'Real'] });
    const call = (id, name, args) => h.call(token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    await call(1, 'PreviewInArgs', { dry_run: true });
    await call(2, 'PreviewInAnswer', {});
    await call(3, 'Failing', {});
    await call(4, 'Real', {});
    assert.deepEqual(h.lines, [
      'PreviewInArgs run=run-9 (dry-run): {"dry_run":true}',
      'PreviewInAnswer run=run-9 (dry-run): {}',
      'Failing run=run-9 (failed): {}',
      'Real run=run-9: {}',
    ]);
  } finally {
    h.done();
  }
});

test('a call Home Assistant never answers is recorded when the run ends, and an answered one is not recorded twice', async () => {
  const h = await withRecording((sent) => (sent.params && sent.params.name === 'Silent' ? null : ok(sent)));
  try {
    const token = h.relay.issue('run-10', MAY);
    await h.call(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Answered', arguments: {} } });
    await h.call(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Silent', arguments: { a: 1 } } });
    assert.deepEqual(h.lines, ['Answered run=run-10: {}'], 'nothing is written for a call still in the air');
    h.relay.revoke(token);
    assert.deepEqual(h.lines, [
      'Answered run=run-10: {}',
      'Silent run=run-10 (no answer): {"a":1}',
    ]);
  } finally {
    h.done();
  }
});

test('a camera read is recorded too, with a line of its own', async () => {
  const lines = [];
  const pics = http.createServer((req, res) => {
    if (req.url === '/api/camera_proxy/camera.missing') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.from([0xff, 0xd8, 0xff]));
  });
  await new Promise((r) => pics.listen(0, '127.0.0.1', r));
  const relayHere = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${pics.address().port}`, haToken: HA_TOKEN, record: (line) => lines.push(line),
  });
  try {
    const token = relayHere.issue('run-11', MAY);
    const get = (entity) => fetch(`${relayHere.url}/api/camera_proxy/${entity}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await get('camera.front_door');
    await get('camera.missing');
    assert.deepEqual(lines, [
      'camera run=run-11: camera.front_door',
      'camera run=run-11 (failed): camera.missing',
    ]);
    // A read nobody may make is not a run's action, so it is not one run's record.
    await fetch(`${relayHere.url}/api/camera_proxy/camera.front_door`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(lines.length, 2);
  } finally {
    relayHere.close();
    pics.close();
  }
});

test('a tool call that expects no answer is recorded when it is sent', async () => {
  // It asks Home Assistant to do something and nothing will ever answer it, so
  // waiting for an answer would mean never recording it at all.
  const h = await withRecording(ok);
  try {
    const token = h.relay.issue('run-12', MAY);
    await h.call(token, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'HassTurnOff', arguments: { name: 'lamp' } } });
    assert.deepEqual(h.lines, ['HassTurnOff run=run-12 (no answer possible): {"name":"lamp"}']);
    // And it is not waiting for anything: the run ends without a second line.
    h.relay.revoke(token);
    assert.equal(h.lines.length, 1);
  } finally {
    h.done();
  }
});

test('a camera read that never gets an answer is recorded as such, and a redirect is not called a failure', async () => {
  const lines = [];
  const pics = http.createServer((req, res) => {
    if (req.url === '/api/camera_proxy/camera.moved') {
      res.writeHead(302, { location: 'http://elsewhere.invalid/x' });
      res.end();
      return;
    }
    // Nothing is answered: the socket is torn down mid-request.
    req.socket.destroy();
  });
  await new Promise((r) => pics.listen(0, '127.0.0.1', r));
  const relayHere = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${pics.address().port}`, haToken: HA_TOKEN, record: (line) => lines.push(line),
  });
  try {
    const token = relayHere.issue('run-13', MAY);
    const get = (entity) => fetch(`${relayHere.url}/api/camera_proxy/${entity}`, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    await get('camera.moved');
    await get('camera.silent');
    assert.deepEqual(lines, [
      'camera run=run-13 (no answer): camera.moved',
      'camera run=run-13 (no answer): camera.silent',
    ], 'neither says the answer was an error, because neither answer was one');
  } finally {
    relayHere.close();
    pics.close();
  }
});

// --- a bearer is what its run may do --------------------------------------------

test('a bearer issued with nothing reaches neither a tool nor a camera', async () => {
  // The window this closes: between minting a bearer and saying what the run may
  // do, a bearer that means "anything" is a bearer that can do anything. So a
  // bearer means nothing until its run says otherwise — and it is told at the
  // moment it is minted, which is why there is no window left at all.
  seen.length = 0;
  const token = relay.issue('run-bare');
  const call = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'GetLiveContext', arguments: {} } }),
  });
  assert.equal(call.status, 200, 'a refusal is answered, not dropped');
  assert.deepEqual(await call.json(), {
    jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Tool not allowed for this run' },
  });
  const camera = await fetch(`${relay.url}/api/camera_proxy/camera.front_door`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(camera.status, 404);
  assert.equal(seen.length, 0, 'nothing reached Home Assistant');
  // The session it may still open: initialising and listing are not acting.
  const list = await fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.equal(list.status, 200);
  assert.equal(seen.length, 1, 'tools/list reached Home Assistant');
});

test('a run reads the camera it was given and no other', async () => {
  // The camera door carries no tool name, and the bearer that opens it is written
  // into the agent's own MCP configuration — the engine is an agent with a shell.
  // So the entity the request named is the whole permission.
  seen.length = 0;
  const token = relay.issue('run-camera', { basenames: ['GetLiveContext'], cameras: ['camera.front_door'] });
  const get = (entity) => fetch(`${relay.url}/api/camera_proxy/${entity}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await get('camera.front_door')).status, 200);
  assert.equal(seen.length, 1);
  for (const other of ['camera.bedroom', 'camera.back_door']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await get(other)).status, 404, other);
  }
  assert.equal(seen.length, 1, 'only the run\'s own camera reached Home Assistant');
  // A run that named no camera reads none, which is the ordinary read request.
  const noCamera = relay.issue('run-no-camera', { basenames: ['GetLiveContext'] });
  const denied = await fetch(`${relay.url}/api/camera_proxy/camera.front_door`, {
    headers: { authorization: `Bearer ${noCamera}` },
  });
  assert.equal(denied.status, 404);
  assert.equal(seen.length, 1);
});

test('a confirmed intent that carries __ is not refused by the rule that reduces it', async () => {
  // INTENT_RE (security.js) allows `_`, so HassFoo__Bar is a legitimate confirmed
  // intent and goes into the bearer. The wire name is reduced to its Home
  // Assistant basename, `Bar`; if the set kept the intent verbatim the two sides
  // would speak different names and EVERY call of that run would be refused while
  // the adapter allowed it — fail-closed and silent. The set is built through the
  // same rule it is compared with, so the divergence cannot exist for any name.
  seen.length = 0;
  const token = relay.issue('run-underscored', { basenames: ['HassFoo__Bar'] });
  const call = (name) => fetch(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  });
  assert.equal((await call('HassFoo__Bar')).status, 200);
  assert.equal(seen.length, 1, 'the run\'s own tool reached Home Assistant');
  // And the reduction does not widen: a different tool that shares no basename is
  // still refused.
  const other = await call('HassTurnOn');
  assert.deepEqual(await other.json(), {
    jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Tool not allowed for this run' },
  });
  assert.equal(seen.length, 1, 'nothing else reached Home Assistant');
});
