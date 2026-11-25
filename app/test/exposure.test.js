'use strict';

// The exact list of entities Home Assistant exposes to its assistant, read over
// the WebSocket API with the Supervisor token. Against a stand-in that speaks the
// protocol: auth_required, auth, auth_ok, then the one command.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { readExposedIds } = require('../server/prompt/exposure');

// `script(ws, send)` runs on each connection once it opens; it decides the answers.
async function withServer(script, run) {
  const seen = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => { wss.on('listening', r); });
  wss.on('connection', (ws) => {
    const send = (o) => ws.send(JSON.stringify(o));
    ws.on('message', (data) => { const m = JSON.parse(data.toString('utf8')); seen.push(m); script(m, send, ws); });
    send({ type: 'auth_required' });
  });
  try {
    return await run(`ws://127.0.0.1:${wss.address().port}`, seen);
  } finally {
    for (const c of wss.clients) c.terminate();
    wss.close();
  }
}

const accepting = (answer) => (m, send) => {
  if (m.type === 'auth') send({ type: m.access_token === 'good' ? 'auth_ok' : 'auth_invalid' });
  else send({ id: m.id, type: 'result', ...answer });
};

test('the exposed ids are the keys exposed to the conversation assistant, and the command is the one list', async () => {
  const answer = {
    success: true,
    result: { exposed_entities: {
      'light.den_2': { conversation: true },
      'switch.heater': { conversation: true, 'cloud.alexa': true },
      'light.other_assistant_only': { 'cloud.alexa': true },
      'light.false': { conversation: false },
    } },
  };
  await withServer(accepting(answer), async (url, seen) => {
    const ids = await readExposedIds({ url, token: 'good' });
    assert.deepEqual([...ids].sort(), ['light.den_2', 'switch.heater']);
    assert.deepEqual(seen, [{ type: 'auth', access_token: 'good' }, { id: 1, type: 'homeassistant/expose_entity/list' }]);
  });
});

test('an id that merely contains another is not that other', async () => {
  await withServer(accepting({ success: true, result: { exposed_entities: { 'light.den_2': { conversation: true } } } }), async (url) => {
    const ids = await readExposedIds({ url, token: 'good' });
    assert.equal(ids.has('light.den'), false);
  });
});

test('a refused token, a refused command and an unreadable answer all reject', async () => {
  await withServer(accepting({ success: true, result: { exposed_entities: {} } }), async (url) => {
    await assert.rejects(readExposedIds({ url, token: 'bad' }), /did not accept the Supervisor token/);
  });
  await withServer(accepting({ success: false, error: { code: 'unauthorized', message: 'Unauthorized' } }), async (url) => {
    await assert.rejects(readExposedIds({ url, token: 'good' }), /refused the exposed-entities list \(unauthorized\)/);
  });
  for (const result of [null, {}, { exposed_entities: [] }, { exposed_entities: 'x' }]) {
    await withServer(accepting({ success: true, result }), async (url) => {
      await assert.rejects(readExposedIds({ url, token: 'good' }), /refused the exposed-entities list/, JSON.stringify(result));
    });
  }
});

test('no token, no connection, a stall, a close and an oversized answer all reject', async () => {
  await assert.rejects(readExposedIds({ url: 'ws://127.0.0.1:1', token: '' }), /no Supervisor token/);
  await assert.rejects(readExposedIds({ url: 'ws://127.0.0.1:1', token: 'good', timeoutMs: 2000 }), /could not be read|closed|did not answer/);
  await withServer(() => {}, async (url) => {
    await assert.rejects(readExposedIds({ url, token: 'good', timeoutMs: 100 }), /did not answer .* in time/);
  });
  await withServer((m, send, ws) => { if (m.type === 'auth') ws.close(); }, async (url) => {
    await assert.rejects(readExposedIds({ url, token: 'good' }), /closed the connection/);
  });
  const big = { exposed_entities: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`light.l${i}`, { conversation: true }])) };
  await withServer(accepting({ success: true, result: big }), async (url) => {
    await assert.rejects(readExposedIds({ url, token: 'good', maxBytes: 256 }), /could not be read/);
  });
});
