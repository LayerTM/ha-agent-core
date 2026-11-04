'use strict';

// How large an answer from Home Assistant may be, driven through the real relay
// over real HTTP against a stub Home Assistant: nothing between the socket and
// the caller is replaced, because the bound lives exactly there.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCoreRelay } = require('../server/prompt/core-relay');
const { resolveAnswer } = require('../server/prompt/targets');

const MIB = 1024 * 1024;
const BOUND_MIB = 16;
const STATES_BOUND_MIB = 64;
const HELD_MIB = BOUND_MIB;

// One state as Home Assistant serves it, attributes and context included.
function stateOf(i) {
  return {
    entity_id: `sensor.device_${i}_power`,
    state: String(i % 100),
    attributes: {
      unit_of_measurement: 'W',
      device_class: 'power',
      friendly_name: `Device ${i} power`,
      attribution: 'x'.repeat(400),
    },
    last_changed: '2026-11-04T21:05:03.000000+00:00',
    last_updated: '2026-11-04T21:05:03.000000+00:00',
    context: { id: `01JAB${i}`, parent_id: null, user_id: null },
  };
}
const BEDROOM = {
  entity_id: 'climate.bedroom',
  state: 'heat',
  attributes: { friendly_name: 'Schlafzimmer "Süd" ☀', temperature: 19 },
};
// About what one large install serves: over 6,000 states, over 3 MiB.
const LARGE_STATES = Buffer.from(JSON.stringify([
  ...Array.from({ length: 6300 }, (_, i) => stateOf(i)),
  BEDROOM,
]));

const LIVE_BEDROOM = `- names: ${BEDROOM.attributes.friendly_name}\n  domain: climate\n  state: heat\n`;
const toolAnswer = (id, text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
const liveAnswer = (id, result) => toolAnswer(id, JSON.stringify({ result }));

let ha;
let answerStates;  // (res) => writes the answer to GET /api/states
let answerRpc;     // (rpc, res) => writes the answer to POST /api/mcp
let relay;
let logged;
let recorded;

const sendJson = (res, value) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
};

// Past the bound, in the pieces a socket would deliver, without holding the whole
// body in memory here.
async function writeOverBound(res, head, mib = BOUND_MIB) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(head);
  const pad = Buffer.alloc(MIB, 0x20);
  for (let i = 0; i <= mib; i += 1) {
    if (!res.write(pad)) await new Promise((resolve) => { res.once('drain', resolve); });
  }
  res.end();
}

const TOOLS = [{ name: 'GetLiveContext' }, { name: 'HassTurnOn' }];
function defaultRpc(rpc, res) {
  if (rpc.method === 'tools/list') return sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: { tools: TOOLS } });
  if (rpc.params?.name === 'GetLiveContext') return sendJson(res, liveAnswer(rpc.id, LIVE_BEDROOM));
  return sendJson(res, toolAnswer(rpc.id, '{"response_type":"action_done"}'));
}

before(async () => {
  ha = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/api/states') return answerStates(res);
      return answerRpc(JSON.parse(Buffer.concat(chunks).toString('utf8')), res);
    });
  });
  await new Promise((resolve) => { ha.listen(0, '127.0.0.1', resolve); });
  relay = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${ha.address().port}`,
    haToken: 'ha-token-never-in-a-message',
    log: (line) => logged.push(line),
    record: (line) => recorded.push(line),
  });
});

after(() => {
  relay.close();
  ha.close();
  ha.closeAllConnections();
});

beforeEach(() => {
  logged = [];
  recorded = [];
  answerStates = (res) => sendJson(res, LARGE_STATES);
  answerRpc = defaultRpc;
});

// What an agent sends through the relay, as an agent sends it.
async function agentCall(rpc) {
  const token = relay.issue('run-agent', { basenames: ['GetLiveContext', 'HassTurnOn'] });
  try {
    const res = await fetch(`${relay.url}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(rpc),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    relay.revoke(token);
  }
}
const CALL = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'GetLiveContext', arguments: {} } };

test('a states list over the client body cap is read', async () => {
  assert.ok(LARGE_STATES.length > 3 * MIB, `fixture is only ${LARGE_STATES.length} bytes`);
  const states = await relay.lookup('run').states();
  assert.equal(states.length, 6301);
  assert.equal(states.at(-1).entity_id, 'climate.bedroom');
  assert.equal(states.at(-1).attributes.friendly_name, BEDROOM.attributes.friendly_name);
});

test('a states list larger than the budget is read, because it is not held', async () => {
  const count = Math.ceil(((HELD_MIB + 4) * MIB) / (LARGE_STATES.length / 6301));
  const list = Buffer.from(JSON.stringify(Array.from({ length: count }, (_, i) => stateOf(i))));
  assert.ok(list.length > (HELD_MIB + 1) * MIB, `fixture is only ${list.length} bytes`);
  answerStates = (res) => sendJson(res, list);
  assert.equal((await relay.lookup('run').states()).length, count);
});

test('only what a lookup reads of each state is kept', async () => {
  const states = await relay.lookup('run').states();
  assert.deepEqual(states[0], { entity_id: 'sensor.device_0_power', attributes: { friendly_name: 'Device 0 power' } });
});

test('a device on a large install resolves to its entity id', async () => {
  const ref = BEDROOM.attributes.friendly_name;
  const { proposal, problems } = await resolveAnswer(
    { proposal: { summary: 'Heat the bedroom', intents: [{ intent: 'HassClimateSetTemperature', targets: [ref], args: { temperature: 21 } }] } },
    relay.lookup('run'),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(proposal.intents[0].targets, ['climate.bedroom']);
});

test('a tool catalog over the client body cap is read', async () => {
  const padded = [...TOOLS, ...Array.from({ length: 3000 }, (_, i) => ({ name: `script_${i}`, description: 'x'.repeat(500) }))];
  answerRpc = (rpc, res) => (rpc.method === 'tools/list'
    ? sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: { tools: padded } })
    : defaultRpc(rpc, res));
  assert.deepEqual(await relay.act('run')('HassTurnOn', { name: 'x' }), { ok: true });
});

test('a live context over the client body cap is read', async () => {
  const large = `${LIVE_BEDROOM}${'- names: Other\n  domain: climate\n'.repeat(60000)}`;
  assert.ok(large.length > MIB);
  answerRpc = (rpc, res) => (rpc.params?.name === 'GetLiveContext'
    ? sendJson(res, liveAnswer(rpc.id, large))
    : defaultRpc(rpc, res));
  const answer = await relay.lookup('run').liveDomain('climate');
  assert.equal(answer.ok, true);
  assert.equal(answer.text, large);
});

test('an action whose answer is over the client body cap is not reported as failed', async () => {
  answerRpc = (rpc, res) => (rpc.method === 'tools/call'
    ? sendJson(res, toolAnswer(rpc.id, JSON.stringify({ response_type: 'action_done', pad: 'x'.repeat(2 * MIB) })))
    : defaultRpc(rpc, res));
  assert.deepEqual(await relay.act('run')('HassTurnOn', { name: 'x' }), { ok: true });
});

test('an agent receives a tool answer over the client body cap, whole', async () => {
  const body = JSON.stringify(toolAnswer(5, 'y'.repeat(2 * MIB)));
  answerRpc = (rpc, res) => sendJson(res, body);
  const { status, text } = await agentCall(CALL);
  assert.equal(status, 200);
  assert.equal(text, body);
  const lines = recorded.filter((l) => l.includes('GetLiveContext'));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('no answer'), lines[0]);
});

test('a client body over its own cap is still refused', async () => {
  const { status, text } = await agentCall({ ...CALL, params: { ...CALL.params, arguments: { pad: 'x'.repeat(MIB) } } });
  assert.equal(status, 413);
  assert.match(text, /too large/);
});

test('a states list past the bound says so, with the bound and without its data', async () => {
  const name = 'bedroom-of-someone';
  answerStates = (res) => writeOverBound(res, `[{"entity_id":"sensor.x","attributes":{"friendly_name":"${name}"}},`, STATES_BOUND_MIB);
  await assert.rejects(relay.lookup('run').states(), (err) => {
    assert.match(err.message, new RegExp(`too large.*${STATES_BOUND_MIB} MiB`));
    assert.ok(!err.message.includes(name));
    return true;
  });
});

test('a tool catalog past the bound says so', async () => {
  answerRpc = (rpc, res) => writeOverBound(res, '{"jsonrpc":"2.0"');
  const answer = await relay.act('run')('HassTurnOn', {});
  assert.equal(answer.ok, false);
  assert.match(answer.error, new RegExp(`tools/list is too large.*${BOUND_MIB} MiB`));
});

test('an action answer past the bound says so, and is recorded as failed', async () => {
  answerRpc = (rpc, res) => (rpc.method === 'tools/call' ? writeOverBound(res, '{"jsonrpc":"2.0"') : defaultRpc(rpc, res));
  const answer = await relay.act('run')('HassTurnOn', { name: 'x' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, new RegExp(`too large.*${BOUND_MIB} MiB`));
  const line = recorded.at(-1);
  assert.ok(line.includes('HassTurnOn') && line.includes('(failed)'), line);
});

test('an agent is told when a tool answer is past the bound, instead of waiting for it', async () => {
  answerRpc = (rpc, res) => writeOverBound(res, '{"house-data":"');
  const { status, text } = await agentCall(CALL);
  assert.equal(status, 502);
  assert.match(text, new RegExp(`too large.*${BOUND_MIB} MiB`));
  const lines = logged.filter((l) => l.includes('too large'));
  assert.equal(lines.length, 1, logged.join('\n'));
  assert.ok(!lines[0].includes('house-data'));
  assert.ok(!lines[0].includes('ha-token-never-in-a-message'));
});

test('a states answer that is not a list is named as that', async () => {
  answerStates = (res) => sendJson(res, '{"message":"nope"}');
  await assert.rejects(relay.lookup('run').states(), /states list is not a list/);
});

test('a states list refused by status names the status', async () => {
  answerStates = (res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('oops'); };
  await assert.rejects(relay.lookup('run').states(), /answered the states list with 500/);
});

test('a states answer cut off midway rejects rather than never settling', async () => {
  answerStates = (res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MIB) });
    res.write('[{"entity_id":"sensor.a"},', () => res.destroy());
  };
  await assert.rejects(relay.lookup('run').states());
});

test('a tool answer cut off midway fails rather than never settling', async () => {
  answerRpc = (rpc, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MIB) });
    res.write('{"jsonrpc":"2.0"', () => res.destroy());
  };
  const answer = await relay.act('run')('HassTurnOn', {});
  assert.equal(answer.ok, false);
});

// --- What is refused, and when: never later than the moment it is known.

// Settles or fails the test, so that "never answered" reads as a failure and not
// as the file's timeout.
function soon(promise, what, ms = 5000) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing after ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Writes `mib` MiB of a JSON string and leaves the answer open, as a stalled
// Home Assistant would. Resolves when the relay has closed the connection.
function writeAndStall(res, head, mib) {
  const closed = new Promise((resolve) => { res.once('close', resolve); });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(head);
  const pad = Buffer.alloc(MIB, 0x20);
  (async () => {
    for (let i = 0; i < mib && !res.destroyed; i += 1) {
      if (!res.write(pad)) {
        await Promise.race([new Promise((resolve) => { res.once('drain', resolve); }), closed]);
      }
    }
  })();
  return closed;
}

test('an agent is refused the moment an answer passes the bound, and the upstream closes', async () => {
  let closed;
  answerRpc = (rpc, res) => { closed = writeAndStall(res, '{"jsonrpc":"2.0"', BOUND_MIB + 2); };
  const { status, text } = await soon(agentCall(CALL), 'refusal');
  assert.equal(status, 502);
  assert.match(text, /too large/);
  await soon(closed, 'upstream close');
});

test('the core is refused the moment a tool answer passes the bound, and the upstream closes', async () => {
  let closed;
  answerRpc = (rpc, res) => { closed = writeAndStall(res, '{"jsonrpc":"2.0"', BOUND_MIB + 2); };
  const answer = await soon(relay.act('run')('HassTurnOn', {}), 'refusal');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /too large/);
  await soon(closed, 'upstream close');
});

test('a states list is refused the moment it passes the bound, and the upstream closes', async () => {
  let closed;
  answerStates = (res) => { closed = writeAndStall(res, '[', STATES_BOUND_MIB + 2); };
  await assert.rejects(soon(relay.lookup('run').states(), 'refusal'), /too large/);
  await soon(closed, 'upstream close');
});

// --- The states list's grammar, over the wire.

for (const text of ['[,]', '[{},]', '[{}{}]', '[,{}]', '[{},,{}]']) {
  test(`${text} over the wire is not a states list`, async () => {
    answerStates = (res) => sendJson(res, text);
    await assert.rejects(relay.lookup('run').states(), /states list is not a list/);
  });
}

// --- An answer that breaks on the way to an agent ends what the agent is reading.

// A connection opened by hand: `res` stays paused until the test reads it.
function openAgent(rpc, headers = {}) {
  const token = relay.issue('run-open', { basenames: ['GetLiveContext'] });
  const body = JSON.stringify(rpc);
  const req = http.request(`${relay.url}/api/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...headers,
    },
  });
  const answered = new Promise((resolve, reject) => {
    req.once('response', (res) => { res.pause(); resolve(res); });
    req.once('error', reject);
  });
  req.end(body);
  return { req, answered, done: () => relay.revoke(token) };
}

const readAll = (res) => new Promise((resolve, reject) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  res.once('error', reject);
  res.once('close', () => { if (!res.complete) reject(new Error('cut off')); });
});

test('an agent is told when a JSON answer is cut off midway', async () => {
  answerRpc = (rpc, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MIB) });
    res.write('{"jsonrpc":"2.0"', () => res.destroy());
  };
  const { status, text } = await soon(agentCall(CALL), 'an answer');
  assert.equal(status, 502);
  assert.match(text, /stopped answering/);
  assert.equal(logged.filter((l) => l.includes('stopped answering')).length, 1, logged.join('\n'));
});

test('an agent reading an event stream sees it end when Home Assistant cuts it', async () => {
  answerRpc = (rpc, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', () => res.destroy());
  };
  const open = openAgent(CALL);
  try {
    const res = await soon(open.answered, 'headers');
    res.resume();
    await assert.rejects(soon(readAll(res), 'the end of the stream'), /cut off|aborted/);
  } finally {
    open.req.destroy();
    open.done();
  }
});

test('an agent reading a refused answer sees it end when Home Assistant cuts it', async () => {
  answerRpc = (rpc, res) => {
    res.writeHead(500, { 'content-type': 'text/plain', 'content-length': String(MIB) });
    res.write('partial', () => res.destroy());
  };
  const open = openAgent(CALL);
  try {
    const res = await soon(open.answered, 'headers');
    res.resume();
    await assert.rejects(soon(readAll(res), 'the end of the answer'), /cut off|aborted/);
  } finally {
    open.req.destroy();
    open.done();
  }
});

// --- One budget for everything held of Home Assistant's answers.

const LARGE_SHARE = Math.ceil(HELD_MIB * 0.6);
const shareBody = (id) => JSON.stringify(toolAnswer(id, 'z'.repeat(LARGE_SHARE * MIB)));

test('answers at the same time share one budget, until the first is delivered', async () => {
  const body = shareBody(5);
  answerRpc = (rpc, res) => (rpc.method === 'tools/list' ? defaultRpc(rpc, res) : sendJson(res, body));
  // The first answer is read from Home Assistant and waits on an agent that is
  // not reading it yet.
  const first = openAgent(CALL);
  try {
    const res = await soon(first.answered, 'the first answer');
    assert.equal(res.statusCode, 200);

    const second = await soon(agentCall(CALL), 'the second answer');
    assert.equal(second.status, 502);
    assert.match(second.text, /too large/);

    const acted = await soon(relay.act('run')('HassTurnOn', {}), 'an action');
    assert.equal(acted.ok, false);
    assert.match(acted.error, /too large/);

    answerStates = (r) => sendJson(r, JSON.stringify([{ entity_id: 'sensor.big', attributes: { pad: 'z'.repeat(LARGE_SHARE * MIB) } }]));
    await assert.rejects(soon(relay.lookup('run').states(), 'a states list'), /too large/);

    res.resume();
    assert.equal(await soon(readAll(res), 'the first answer, read', 20000), body);
  } finally {
    first.req.destroy();
    first.done();
  }
  // Delivered, it no longer counts.
  const third = await soon(agentCall(CALL), 'the third answer', 20000);
  assert.equal(third.status, 200);
  assert.equal(third.text, body);
});

test('an agent that goes away gives its share back and closes the upstream', async () => {
  let closed;
  let stalled;
  const wrote = new Promise((resolve) => { stalled = resolve; });
  answerRpc = (rpc, res) => {
    closed = writeAndStall(res, '{"jsonrpc":"2.0"', LARGE_SHARE);
    stalled();
  };
  const gone = openAgent(CALL);
  gone.answered.catch(() => {});
  await soon(wrote, 'the stub');
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  gone.req.destroy();
  gone.done();
  await soon(closed, 'upstream close');

  const body = shareBody(5);
  answerRpc = (rpc, res) => sendJson(res, body);
  const { status } = await soon(agentCall(CALL), 'the next answer', 20000);
  assert.equal(status, 200);
});

test('an answer cut off midway gives its share back', async () => {
  answerRpc = (rpc, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(HELD_MIB * MIB) });
    res.write(Buffer.alloc(LARGE_SHARE * MIB, 0x20), () => res.destroy());
  };
  assert.equal((await soon(agentCall(CALL), 'the cut answer', 20000)).status, 502);
  const cutAct = await soon(relay.act('run')('HassTurnOn', {}), 'the cut action', 20000);
  assert.equal(cutAct.ok, false);

  const body = shareBody(5);
  answerRpc = (rpc, res) => sendJson(res, body);
  assert.equal((await soon(agentCall(CALL), 'the next answer', 20000)).status, 200);
});

test('a states list that stalls is given up on, and gives its share back', async () => {
  answerStates = (res) => { writeAndStall(res, '[{"entity_id":"sensor.a","pad":"', LARGE_SHARE); };
  await assert.rejects(soon(relay.lookup('run').states(), 'the idle timeout', 15000));
  const body = shareBody(5);
  answerRpc = (rpc, res) => sendJson(res, body);
  assert.equal((await soon(agentCall(CALL), 'the next answer', 20000)).status, 200);
});
