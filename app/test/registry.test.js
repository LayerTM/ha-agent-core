'use strict';

// The entity registry's aliases, read over the WebSocket API with the Home
// Assistant token. Against a stand-in that speaks the protocol: auth_required,
// auth, auth_ok, then the one command.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { readEntityAliases, coreWebSocketUrl } = require('../server/prompt/registry');

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

test('the aliases are the strings of each asked entry, and the command asks for exactly those ids', async () => {
  const result = {
    'light.den': { entity_id: 'light.den', aliases: [null] },
    'input_boolean.den_2': { entity_id: 'input_boolean.den_2', aliases: [null, 'Den', ' ', 7] },
    'switch.heater': { entity_id: 'switch.heater', aliases: ['Warmer'] },
    'light.unknown': null,
    'light.not_asked': { entity_id: 'light.not_asked', aliases: ['Den'] },
  };
  await withServer(accepting({ success: true, result }), async (url, seen) => {
    const aliases = await readEntityAliases({ url, token: 'good', entityIds: ['light.den', 'input_boolean.den_2', 'switch.heater', 'light.unknown', 'light.den'] });
    assert.deepEqual([...aliases], [['input_boolean.den_2', ['Den']], ['switch.heater', ['Warmer']]]);
    assert.deepEqual(seen, [
      { type: 'auth', access_token: 'good' },
      { id: 1, type: 'config/entity_registry/get_entries', entity_ids: ['light.den', 'input_boolean.den_2', 'switch.heater', 'light.unknown'] },
    ]);
  });
});

test('an entry whose aliases are not a list names nothing', async () => {
  const result = { 'light.a': { aliases: 'Den' }, 'light.b': {}, 'light.c': 'x' };
  await withServer(accepting({ success: true, result }), async (url) => {
    assert.equal((await readEntityAliases({ url, token: 'good', entityIds: ['light.a', 'light.b', 'light.c'] })).size, 0);
  });
});

test('no ids asks nothing', async () => {
  assert.equal((await readEntityAliases({ url: 'ws://127.0.0.1:1', token: 'good', entityIds: [] })).size, 0);
});

test('a refused token, a refused command, an unreadable answer and no token all reject', async () => {
  await withServer(accepting({ success: true, result: {} }), async (url) => {
    await assert.rejects(readEntityAliases({ url, token: 'bad', entityIds: ['light.a'] }), /did not accept the Home Assistant token/);
  });
  await withServer(accepting({ success: false, error: { code: 'unauthorized' } }), async (url) => {
    await assert.rejects(readEntityAliases({ url, token: 'good', entityIds: ['light.a'] }), /refused the entity registry \(unauthorized\)/);
  });
  for (const result of [null, [], 'x']) {
    await withServer(accepting({ success: true, result }), async (url) => {
      await assert.rejects(readEntityAliases({ url, token: 'good', entityIds: ['light.a'] }), /refused the entity registry/, JSON.stringify(result));
    });
  }
  await assert.rejects(readEntityAliases({ url: 'ws://127.0.0.1:1', token: '', entityIds: ['light.a'] }), /no Home Assistant token/);
});

test("Core's WebSocket endpoint follows its origin's scheme", () => {
  assert.equal(coreWebSocketUrl('http://homeassistant:8123'), 'ws://homeassistant:8123/api/websocket');
  assert.equal(coreWebSocketUrl('https://ha.example:8123'), 'wss://ha.example:8123/api/websocket');
});
