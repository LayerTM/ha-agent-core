'use strict';

// A confirmed write, carried out through the real relay against a fake Home
// Assistant Core: what each action reports is what Core answered to it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { startCoreRelay } = require('../server/prompt/core-relay');
const { execute } = require('../server/prompt/execute');

const HA_TOKEN = 'ha-llat-execute-0123456789';

// The answer of an intent tool, as Home Assistant's MCP server sends it: the
// intent response as JSON text.
const intentAnswer = (response, isError = false) => ({
  content: [{ type: 'text', text: typeof response === 'string' ? response : JSON.stringify(response) }],
  ...(isError ? { isError: true } : {}),
});
const DONE = { response_type: 'action_done', data: { targets: [], success: [{ name: 'Lamp', type: 'entity', id: 'light.lamp' }], failed: [] } };

// A Core that publishes `tools` and answers each tools/call with
// `answerFor(name, args)`: a result object, {error} for a JSON-RPC error, or
// 'drop' to answer nothing at all.
async function withCore(tools, answerFor, fn) {
  const sent = [];
  const lines = [];
  const core = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sent.push(message);
      let reply;
      if (message.method === 'tools/list') {
        reply = { jsonrpc: '2.0', id: message.id, result: { tools: tools.map((name) => ({ name })) } };
      } else {
        const answer = answerFor(message.params.name, message.params.arguments);
        if (answer === 'drop') { req.socket.destroy(); return; }
        reply = answer.error ? { jsonrpc: '2.0', id: message.id, error: answer.error } : { jsonrpc: '2.0', id: message.id, result: answer };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => { core.listen(0, '127.0.0.1', r); });
  const relay = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${core.address().port}`, haToken: HA_TOKEN, record: (line) => lines.push(line),
  });
  try {
    return await fn({ act: relay.act('run-w1'), sent, lines });
  } finally {
    relay.close();
    core.closeAllConnections();
    core.close();
  }
}

const calls = (sent) => sent.filter((m) => m.method === 'tools/call').map((m) => [m.params.name, m.params.arguments]);

test('a write whose Home Assistant call failed reports that action failed, not done', async () => {
  // The confirmed write that used to answer "Done": HassTurnOn on the lamp,
  // refused by Home Assistant.
  await withCore(['HassTurnOn'], () => intentAnswer('Unable to turn on: no entity matched', true), async ({ act, sent, lines }) => {
    const actions = await execute([{ intent: 'HassTurnOn', targets: ['light.sandbox_test_lamp'], data: {} }], act);
    assert.deepEqual(actions, [
      { intent: 'HassTurnOn', target: 'light.sandbox_test_lamp', ok: false, error: 'Unable to turn on: no entity matched' },
    ]);
    assert.deepEqual(calls(sent), [['HassTurnOn', { name: 'light.sandbox_test_lamp' }]], 'the entity id itself is the name');
    assert.deepEqual(lines, ['HassTurnOn run=run-w1 (failed): {"name":"light.sandbox_test_lamp"}']);
  });
});

test('an action Home Assistant carried out is ok, under the name it publishes the tool by', async () => {
  await withCore(['assist__HassTurnOn', 'assist__HassTurnOff'], () => intentAnswer(DONE), async ({ act, sent, lines }) => {
    const actions = await execute([
      { intent: 'HassTurnOn', targets: ['light.lamp', 'light.desk'], data: {} },
      { intent: 'HassTurnOff', targets: ['switch.fan'], data: {} },
    ], act);
    assert.deepEqual(actions.map((a) => a.ok), [true, true, true]);
    assert.deepEqual(calls(sent).map(([name]) => name), ['assist__HassTurnOn', 'assist__HassTurnOn', 'assist__HassTurnOff']);
    assert.equal(sent.filter((m) => m.method === 'tools/list').length, 1, 'the tool list is asked for once');
    assert.deepEqual(lines, [
      'assist__HassTurnOn run=run-w1: {"name":"light.lamp"}',
      'assist__HassTurnOn run=run-w1: {"name":"light.desk"}',
      'assist__HassTurnOff run=run-w1: {"name":"switch.fan"}',
    ]);
  });
});

test('every way Home Assistant can say an action failed is read as a failure, with its reason', async () => {
  const cases = [
    ['isError carrying {error}', intentAnswer({ error: "No exposed entities matched name 'light.x'" }, true), "No exposed entities matched name 'light.x'"],
    ['an intent that ran but failed its target', intentAnswer({ response_type: 'action_done', data: { success: [], failed: [{ name: 'Lamp', id: 'light.x' }] } }), 'Home Assistant could not act on Lamp'],
    ['an intent error response', intentAnswer({ response_type: 'error', speech: { plain: { speech: 'Sorry, I am not aware of any device called light.x' } } }), 'Sorry, I am not aware of any device called light.x'],
    ['a JSON-RPC error', { error: { code: -32602, message: 'Invalid arguments' } }, 'Invalid arguments'],
  ];
  for (const [label, answer, error] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await withCore(['HassTurnOn'], () => answer, async ({ act, lines }) => {
      const [action] = await execute([{ intent: 'HassTurnOn', targets: ['light.x'], data: {} }], act);
      assert.deepEqual(action, { intent: 'HassTurnOn', target: 'light.x', ok: false, error }, label);
      assert.deepEqual(lines, ['HassTurnOn run=run-w1 (failed): {"name":"light.x"}'], label);
    });
  }
});

test('a call Home Assistant never answered is a failure recorded as unanswered, and the next one still runs', async () => {
  let n = 0;
  const answerFor = () => { n += 1; return n === 1 ? 'drop' : intentAnswer(DONE); };
  await withCore(['HassTurnOn'], answerFor, async ({ act, lines }) => {
    const actions = await execute([{ intent: 'HassTurnOn', targets: ['light.a', 'light.b'], data: {} }], act);
    assert.equal(actions[0].ok, false);
    assert.match(actions[0].error, /^Home Assistant did not answer: /);
    assert.deepEqual(actions[1], { intent: 'HassTurnOn', target: 'light.b', ok: true });
    assert.deepEqual(lines, [
      'HassTurnOn run=run-w1 (no answer): {"name":"light.a"}',
      'HassTurnOn run=run-w1: {"name":"light.b"}',
    ]);
  });
});

test('an intent Home Assistant does not publish fails without a call', async () => {
  await withCore(['HassTurnOn'], () => intentAnswer(DONE), async ({ act, sent, lines }) => {
    const actions = await execute([{ intent: 'HassVacuumStart', targets: ['vacuum.robo'], data: {} }], act);
    assert.deepEqual(actions, [
      { intent: 'HassVacuumStart', target: 'vacuum.robo', ok: false, error: 'Home Assistant publishes no HassVacuumStart tool' },
    ]);
    assert.deepEqual(calls(sent), []);
    assert.deepEqual(lines, []);
  });
});

test('an action not started before the deadline is a failure, and nothing is called for it', async () => {
  let called = 0;
  const actions = await execute(
    [{ intent: 'HassTurnOn', targets: ['light.a'], data: {} }],
    async () => { called += 1; return { ok: true }; },
    { deadline: Date.now() - 1 },
  );
  assert.deepEqual(actions, [{ intent: 'HassTurnOn', target: 'light.a', ok: false, error: 'not attempted: the request ran out of time' }]);
  assert.equal(called, 0);
});

test("an action's error is one bounded line", async () => {
  const actions = await execute(
    [{ intent: 'HassTurnOn', targets: ['light.a'], data: {} }],
    async () => ({ ok: false, error: `line one\nline two ${'x'.repeat(400)}` }),
  );
  assert.equal(actions[0].error.includes('\n'), false);
  assert.ok(actions[0].error.startsWith('line one line two '));
  assert.equal(actions[0].error.length, 300);
});
