'use strict';

// How large an answer from Home Assistant may be, driven through the real relay
// over real HTTP against a stub Home Assistant: nothing between the socket and
// the caller is replaced, because the bound lives exactly there.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { fork } = require('node:child_process');
const v8 = require('node:v8');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useAdapter } = require('../server/adapter-contract');
const { createNeutralAdapter } = require('./fixtures/neutral-adapter');

const neutral = createNeutralAdapter();
useAdapter(neutral.adapter, neutral.branding);

const { startCoreRelay } = require('../server/prompt/core-relay');
const { resolveAnswer } = require('../server/prompt/targets');
const { createPromptApp } = require('../server/prompt/server');
const { TARGET_TEXT } = require('../server/prompt/notices');

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
let onRecord = () => {};

// Resolves once `count` audit lines match `pattern`: the relay writes one only when it
// has read an answer through, which is the moment that answer's share is given back.
async function recordedLines(pattern, count) {
  while (recorded.filter((line) => pattern.test(line)).length < count) {
    await new Promise((resolve) => { onRecord = resolve; });
  }
}

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
    record: (line) => {
      recorded.push(line);
      onRecord();
    },
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
async function agentCall(rpc, through = relay) {
  const token = through.issue('run-agent', { basenames: ['GetLiveContext', 'HassTurnOn'] });
  try {
    const res = await fetch(`${through.url}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(rpc),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    through.revoke(token);
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

test('an action answer past the bound says so, and is recorded as unread', async () => {
  answerRpc = (rpc, res) => (rpc.method === 'tools/call' ? writeOverBound(res, '{"jsonrpc":"2.0"') : defaultRpc(rpc, res));
  const answer = await relay.act('run')('HassTurnOn', { name: 'x' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, new RegExp(`too large.*${BOUND_MIB} MiB`));
  // The action went out; only its answer could not be read.
  const line = recorded.at(-1);
  assert.ok(line.includes('HassTurnOn') && line.includes('(answer too large)'), line);
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
function openAgent(rpc, headers = {}, through = relay) {
  const token = through.issue('run-open', { basenames: ['GetLiveContext'] });
  const body = JSON.stringify(rpc);
  const req = http.request(`${through.url}/api/mcp`, {
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
  return { req, answered, done: () => through.revoke(token) };
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

test('answers to agents share one budget until delivered; the core\'s own are not refused by them', async () => {
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

    const acted = await soon(relay.act('run')('HassTurnOn', {}), 'an action', 20000);
    assert.equal(acted.ok, true, acted.error);

    answerStates = (r) => sendJson(r, JSON.stringify([{ entity_id: 'sensor.big', attributes: { pad: 'z'.repeat(LARGE_SHARE * MIB) } }]));
    const list = await soon(relay.lookup('run').states(), 'a states list', 20000);
    assert.equal(list[0].entity_id, 'sensor.big');

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

test('an agent gone before Home Assistant answers leaves the tool running and takes no share', async () => {
  const body = shareBody(5);
  // Twice, because one lost share would still leave room for one more answer.
  for (let round = 0; round < 2; round += 1) {
    let arrived;
    const asked = new Promise((resolve) => { arrived = resolve; });
    answerRpc = (rpc, res) => arrived(res);
    const gone = openAgent(CALL);
    gone.answered.catch(() => {});
    const held = await soon(asked, 'the stub');
    let closedEarly = false;
    held.once('close', () => { closedEarly = !held.writableFinished; });
    gone.req.destroy();
    gone.done();
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.equal(closedEarly, false, 'the request closed, which cancels the tool');
    // Written is not read: the relay holds a share for this answer until it has
    // read it to its end, and only then says how the tool ended.
    sendJson(held, body);
    await soon(recordedLines(/answered after its run ended/, round + 1), 'the late answer, read', 20000);
  }
  answerRpc = (rpc, res) => sendJson(res, body);
  assert.equal((await soon(agentCall(CALL), 'the next answer', 20000)).status, 200);
});

test('a request with no tool behind it closes when its agent leaves', async () => {
  const rawHa = http.createServer();
  let closed;
  let arrived;
  const asked = new Promise((resolve) => { arrived = resolve; });
  rawHa.on('request', (req, res) => {
    closed = new Promise((resolve) => { res.once('close', resolve); });
    arrived();
  });
  await new Promise((resolve) => { rawHa.listen(0, '127.0.0.1', resolve); });
  const short = await startCoreRelay({ coreOrigin: `http://127.0.0.1:${rawHa.address().port}`, haToken: 'ha-token-never-in-a-message' });
  const token = short.issue('run-get', { basenames: [] });
  const leaving = new AbortController();
  const call = fetch(`${short.url}/api/mcp`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: leaving.signal,
  }).catch(() => {});
  try {
    await soon(asked, 'the stub');
    leaving.abort();
    await call;
    await soon(closed, 'the request closing');
  } finally {
    short.revoke(token);
    short.close();
    rawHa.close();
    rawHa.closeAllConnections();
  }
});

// A Home Assistant that reads each request and has not answered it yet, keeping
// nothing of it: what stays in this process is what the relay keeps.
async function silentHa() {
  const open = [];
  let notify = () => {};
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      open.push(res);
      notify();
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    open,
    url: `http://127.0.0.1:${server.address().port}`,
    async received(count) {
      while (open.length < count) {
        await new Promise((resolve) => { notify = resolve; });
      }
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
const TOOL_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'HassTurnOn', arguments: {} } };
const PING = { jsonrpc: '2.0', id: 1, method: 'ping', params: {} };
function postThrough(through, token, rpc) {
  const leaving = new AbortController();
  const answer = fetch(`${through.url}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(rpc),
    signal: leaving.signal,
  });
  answer.catch(() => {});
  return { answer, leave: () => leaving.abort() };
}
const settle = () => new Promise((resolve) => { setTimeout(resolve, 100); });

test('a request whose agent has left does not keep its body in memory', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const stub = await silentHa();
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', authProbeEveryMs: 0 });
  const token = short.issue('run-held', { basenames: ['HassTurnOn'] });
  const padded = { ...TOOL_CALL, params: { name: 'HassTurnOn', arguments: { padding: 'p'.repeat(256 * 1024) } } };
  try {
    gc();
    const buffersAtStart = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 40; i += 1) {
      const call = postThrough(short, token, padded);
      await soon(stub.received(i + 1), 'the request');
      call.leave();
      await settle();
    }
    gc();
    await settle();
    gc();
    const kept = process.memoryUsage().arrayBuffers - buffersAtStart;
    assert.equal(stub.open.filter((r) => !r.destroyed).length, 40, 'every request stays open');
    assert.ok(kept < 2 * MIB, `${(kept / MIB).toFixed(1)} MiB kept of 10 MiB sent`);
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

test('past the bound new requests are refused by name, and what runs is never closed', async () => {
  const stub = await silentHa();
  const short = await startCoreRelay({
    coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', authProbeEveryMs: 0, maxUnansweredRequests: 2, log: (l) => logged.push(l),
  });
  const token = short.issue('run-bound', { basenames: ['HassTurnOn'] });
  try {
    // One agent left and one stays: both are waiting, and both count.
    const left = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(1), 'the first request');
    left.leave();
    await settle();
    const stays = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(2), 'the second request');

    const refused = await soon(postThrough(short, token, TOOL_CALL).answer, 'the refusal');
    assert.equal(refused.status, 503);
    assert.match((await refused.json()).error, /too many requests are waiting for Home Assistant/);
    assert.equal(stub.open.length, 2, 'the refused request went nowhere');
    assert.ok(stub.open.every((r) => !r.destroyed), 'a running tool was closed');
    assert.ok(logged.some((l) => l.includes('too many requests are waiting')), logged.join('\n'));

    // An answer that has started frees its place, though it has not finished.
    stub.open[1].writeHead(200, { 'content-type': 'text/event-stream' });
    stub.open[1].write(': working\n\n');
    await settle();
    const next = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(3), 'the next request');
    stub.open[1].end();
    assert.equal((await soon(stays.answer, 'the answer it stayed for')).status, 200);
    sendJson(stub.open[2], { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal((await soon(next.answer, 'the next answer')).status, 200);
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

test('an answer that starts for an agent that left keeps its place until it ends', async () => {
  const stub = await silentHa();
  const short = await startCoreRelay({
    coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', authProbeEveryMs: 0, maxUnansweredRequests: 1,
  });
  const token = short.issue('run-started', { basenames: ['HassTurnOn'] });
  try {
    const left = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(1), 'the request');
    left.leave();
    await settle();
    stub.open[0].writeHead(200, { 'content-type': 'application/json' });
    stub.open[0].write('{');
    await settle();
    assert.equal((await soon(postThrough(short, token, TOOL_CALL).answer, 'the refusal')).status, 503);
    stub.open[0].end('}');
    await settle();
    const next = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(2), 'the next request');
    sendJson(stub.open[1], { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal((await soon(next.answer, 'the next answer')).status, 200);
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

test('a request that ends without an answer frees its place, however its agent left', async () => {
  const dropping = http.createServer((req) => { req.resume(); req.once('end', () => req.socket.destroy()); });
  await new Promise((resolve) => { dropping.listen(0, '127.0.0.1', resolve); });
  const short = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${dropping.address().port}`, haToken: 'ha-token-never-in-a-message', authProbeEveryMs: 0, maxUnansweredRequests: 1,
  });
  const token = short.issue('run-dropped', { basenames: ['HassTurnOn'] });
  try {
    for (let i = 0; i < 40; i += 1) {
      const call = postThrough(short, token, TOOL_CALL);
      // Around the moment the connection drops, so the two ends close in either order.
      setTimeout(() => call.leave(), i % 8);
      await call.answer.catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    await settle();
    const last = await soon(postThrough(short, token, TOOL_CALL).answer, 'the last call');
    assert.equal(last.status, 502, 'it reached Home Assistant, which dropped it');
  } finally {
    short.revoke(token);
    short.close();
    dropping.close();
    dropping.closeAllConnections();
  }
});

test('a tool that outlives its agent is not waited for without end', async () => {
  const short = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${ha.address().port}`,
    haToken: 'ha-token-never-in-a-message',
    abandonedRequestMs: 300,
  });
  const token = short.issue('run-gone', { basenames: ['GetLiveContext'] });
  let closed;
  let arrived;
  const asked = new Promise((resolve) => { arrived = resolve; });
  answerRpc = (rpc, res) => {
    closed = new Promise((resolve) => { res.once('close', resolve); });
    arrived();
  };
  const leaving = new AbortController();
  const call = fetch(`${short.url}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(CALL),
    signal: leaving.signal,
  }).catch(() => {});
  try {
    await soon(asked, 'the stub');
    leaving.abort();
    await call;
    await soon(closed, 'the request closing at the limit');
  } finally {
    short.revoke(token);
    short.close();
  }
});

test('an agent gone while the answer arrives gives its share back on every order', async () => {
  const body = shareBody(5);
  for (const wait of [0, 1, 5, 20]) {
    answerRpc = (rpc, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(body.slice(0, MIB));
      setTimeout(() => res.end(body.slice(MIB)), wait);
    };
    const gone = openAgent(CALL);
    gone.answered.catch(() => {});
    await new Promise((resolve) => { setTimeout(resolve, wait); });
    gone.req.destroy();
    gone.done();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  answerRpc = (rpc, res) => sendJson(res, body);
  assert.equal((await soon(agentCall(CALL), 'the next answer', 20000)).status, 200);
});

const sseCall = () => openAgent(CALL, { accept: 'application/json, text/event-stream' });

test('an event past the budget ends the stream, gives its share back and leaves the tool running', async () => {
  let closed;
  answerRpc = (rpc, res) => {
    closed = new Promise((resolve) => { res.once('close', resolve); });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const pad = Buffer.alloc(MIB, 0x7a);
    res.write('data: ');
    (async () => {
      for (let i = 0; i <= HELD_MIB + 1 && !res.destroyed; i += 1) {
        if (!res.write(pad)) await Promise.race([new Promise((r) => { res.once('drain', r); }), closed]);
      }
    })();
  };
  const open = sseCall();
  try {
    // No event was complete, so the end may come before any header reached the agent.
    await assert.rejects(soon(open.answered.then((res) => {
      res.resume();
      return readAll(res);
    }), 'the end of the stream', 20000));
    assert.equal(logged.filter((l) => l.includes('too large')).length, 1, logged.join('\n'));
  } finally {
    open.req.destroy();
    open.done();
  }
  const body = shareBody(5);
  answerRpc = (rpc, res) => sendJson(res, body);
  assert.equal((await soon(agentCall(CALL), 'the next answer', 20000)).status, 200);
});

test('an agent not reading a stream slows Home Assistant rather than filling memory', async () => {
  let sent = 0;
  let closed;
  const event = `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { pad: 'p'.repeat(MIB) } })}\n\n`;
  answerRpc = (rpc, res) => {
    closed = new Promise((resolve) => { res.once('close', resolve); });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    (async () => {
      while (!res.destroyed && sent < 200) {
        sent += 1;
        if (!res.write(event)) await Promise.race([new Promise((r) => { res.once('drain', r); }), closed]);
      }
    })();
  };
  const open = sseCall();
  const res = await soon(open.answered, 'headers');
  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  assert.ok(sent < 60, `${sent} MiB went out to an agent that read none of it`);
  open.req.destroy();
  open.done();
  res.destroy();
});

// An agent that reads none of its answer, and either says nothing or keeps sending
// bytes, which refreshes any limit that watches the socket for activity.
for (const [how, keepsSending] of [['says nothing', false], ['keeps sending bytes', true]]) {
  test(`an agent that reads nothing and ${how} loses the answer at the deadline`, async () => {
    const short = await startCoreRelay({
      coreOrigin: `http://127.0.0.1:${ha.address().port}`,
      haToken: 'ha-token-never-in-a-message',
      deliveryDeadlineMs: 1500,
    });
    const token = short.issue('run-idle', { basenames: ['GetLiveContext'] });
    const rpc = JSON.stringify(CALL);
    const socket = net.connect(short.port, '127.0.0.1');
    socket.on('error', () => {});
    socket.pause();
    socket.write(`POST /api/mcp HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer ${token}\r\n`
      + `Content-Type: application/json\r\nAccept: application/json\r\nContent-Length: ${rpc.length}\r\n\r\n${rpc}`);
    const dribble = keepsSending
      ? setInterval(() => { if (!socket.destroyed) socket.write('\r\n'); }, 300)
      : null;
    try {
      const body = shareBody(5);
      answerRpc = (r, res) => sendJson(res, body);
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      assert.equal((await soon(agentCall(CALL, short), 'while it holds its share')).status, 502);
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      assert.equal((await soon(agentCall(CALL, short), 'past the deadline', 20000)).status, 200);
    } finally {
      if (dribble) clearInterval(dribble);
      socket.destroy();
      short.revoke(token);
      short.close();
    }
  });
}

test('an agent reading at an ordinary pace is not cut off', async () => {
  const short = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${ha.address().port}`,
    haToken: 'ha-token-never-in-a-message',
    deliveryDeadlineMs: 1500,
  });
  try {
    const body = shareBody(5);
    answerRpc = (r, res) => sendJson(res, body);
    const { status, text } = await soon(agentCall(CALL, short), 'the answer', 20000);
    assert.equal(status, 200);
    assert.equal(text, body);
    // The timer goes with the answer: the connection is still usable afterwards.
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    assert.equal((await soon(agentCall(CALL, short), 'the next answer', 20000)).status, 200);
  } finally {
    short.close();
  }
});

test('an answer that stalls on its way to an agent is given up on', async () => {
  answerRpc = (rpc, res) => { writeAndStall(res, '{"jsonrpc":"2.0"', LARGE_SHARE); };
  const { status, text } = await soon(agentCall(CALL), 'the idle limit', 15000);
  assert.equal(status, 502);
  assert.match(text, /stopped answering/);
  const body = shareBody(5);
  answerRpc = (rpc, res) => sendJson(res, body);
  assert.equal((await soon(agentCall(CALL), 'the next answer', 20000)).status, 200);
});

test('the core\'s own answers share a budget of their own', async () => {
  let stalled = null;
  answerRpc = (rpc, res) => {
    if (rpc.method === 'tools/list') return defaultRpc(rpc, res);
    if (stalled === null) {
      stalled = res;
      return writeAndStall(res, '{"jsonrpc":"2.0"', LARGE_SHARE);
    }
    return sendJson(res, shareBody(rpc.id));
  };
  const act = relay.act('run');
  const first = act('HassTurnOn', {});
  await new Promise((resolve) => { setTimeout(resolve, 500); });
  const second = await soon(act('HassTurnOn', {}), 'the second action', 20000);
  assert.equal(second.ok, false);
  assert.match(second.error, /too large/);
  stalled.destroy();
  assert.equal((await soon(first, 'the first action')).ok, false);
});

// --- An event stream holds what it has not delivered, and not for ever.

const SSE = { accept: 'application/json, text/event-stream' };
const sseOf = (id, pad) => `data: ${JSON.stringify(toolAnswer(id, pad))}\n\n`;
const shortRelay = (options) => startCoreRelay({
  coreOrigin: `http://127.0.0.1:${ha.address().port}`,
  haToken: 'ha-token-never-in-a-message',
  log: (line) => logged.push(line),
  ...options,
});
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const streamHead = (res) => res.writeHead(200, { 'content-type': 'text/event-stream' });

test('a whole event an agent has not read still counts against the budget', async () => {
  const event = sseOf(5, 'z'.repeat(LARGE_SHARE * MIB));
  answerRpc = (rpc, res) => { streamHead(res); res.end(event); };
  const first = openAgent(CALL, SSE);
  try {
    const res = await soon(first.answered, 'the stream');
    await sleep(500);
    const body = shareBody(5);
    answerRpc = (rpc, r) => sendJson(r, body);
    const second = await soon(agentCall(CALL), 'the second answer', 20000);
    assert.equal(second.status, 502);
    assert.match(second.text, /too large/);
    res.resume();
    assert.equal(await soon(readAll(res), 'the stream, read', 20000), event);
    // Delivered, it no longer counts.
    assert.equal((await soon(agentCall(CALL), 'the third answer', 20000)).status, 200);
  } finally {
    first.req.destroy();
    first.done();
  }
});

test('an agent not reading an event loses the stream at the deadline, and its share', async () => {
  const short = await shortRelay({ deliveryDeadlineMs: 1000 });
  answerRpc = (rpc, res) => {
    streamHead(res);
    res.write(sseOf(5, 'z'.repeat(LARGE_SHARE * MIB)));
  };
  const open = openAgent(CALL, SSE, short);
  try {
    await soon(open.answered, 'the stream');
    await sleep(1500);
    const body = shareBody(5);
    answerRpc = (rpc, r) => sendJson(r, body);
    assert.equal((await soon(agentCall(CALL, short), 'the next answer', 20000)).status, 200);
  } finally {
    open.req.destroy();
    open.done();
    short.close();
  }
});

test('an event Home Assistant stops halfway ends the stream and gives its share back', async () => {
  const short = await shortRelay({ answerStallMs: 300 });
  answerRpc = (rpc, res) => {
    streamHead(res);
    res.write(`data: ${'z'.repeat(LARGE_SHARE * MIB)}`);
  };
  const open = openAgent(CALL, SSE, short);
  try {
    // No event was complete, so the end may come before any header reached the agent.
    await assert.rejects(soon(open.answered.then((res) => {
      res.resume();
      return readAll(res);
    }), 'the end of the stream', 5000), /cut off|aborted|hang up/);
    assert.ok(logged.some((l) => l.includes('stopped answering')), logged.join('\n'));
    const body = shareBody(5);
    answerRpc = (rpc, r) => sendJson(r, body);
    assert.equal((await soon(agentCall(CALL, short), 'the next answer', 20000)).status, 200);
  } finally {
    open.req.destroy();
    open.done();
    short.close();
  }
});

test('a stream with no event in progress may be silent for as long as a tool takes', async () => {
  const short = await shortRelay({ answerStallMs: 200, deliveryDeadlineMs: 200 });
  const start = sseOf(1, 'working');
  const late = sseOf(5, 'done');
  answerRpc = (rpc, res) => {
    streamHead(res);
    res.write(start);
    setTimeout(() => res.end(late), 1000);
  };
  const open = openAgent(CALL, SSE, short);
  try {
    const res = await soon(open.answered, 'the stream');
    res.resume();
    assert.equal(await soon(readAll(res), 'the whole stream'), start + late);
  } finally {
    open.req.destroy();
    open.done();
    short.close();
  }
});

test('an upstream paused for a slow agent is not taken for a stalled one', async () => {
  const short = await shortRelay({ answerStallMs: 1000 });
  const big = sseOf(1, 'z'.repeat(LARGE_SHARE * MIB));
  answerRpc = (rpc, res) => {
    streamHead(res);
    res.write(`${big}data: {"jsonrpc":"2.0","id":5,`);
    setTimeout(() => res.end('"result":{}}\n\n'), 2000);
  };
  const open = openAgent(CALL, SSE, short);
  try {
    const res = await soon(open.answered, 'the stream');
    await sleep(1500);
    res.resume();
    const text = await soon(readAll(res), 'the whole stream', 20000);
    assert.equal(text, `${big}data: {"jsonrpc":"2.0","id":5,"result":{}}\n\n`);
  } finally {
    open.req.destroy();
    open.done();
    short.close();
  }
});

test('one event nearly the size of the budget reaches an agent, whole', async () => {
  const event = sseOf(5, 'z'.repeat((BOUND_MIB - 1) * MIB));
  answerRpc = (rpc, res) => { streamHead(res); res.end(event); };
  const open = openAgent(CALL, SSE);
  try {
    const res = await soon(open.answered, 'the stream');
    res.resume();
    assert.equal(await soon(readAll(res), 'the event', 20000), event);
  } finally {
    open.req.destroy();
    open.done();
  }
});

// --- What the person asking is told.

async function askThroughApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-size-'));
  const app = createPromptApp({
    token: 'contract-token-0123456789abcdef',
    claudeBin: path.join(dir, 'none'),
    claudeSettings: 's',
    usageBin: path.join(dir, 'none'),
    haConfigured: true,
    model: 'm',
    workDir: dir,
    addonVersion: 't',
    redact: (text) => text,
    audit: () => {},
    lookupFor: (runId) => relay.lookup(runId),
    runAgent: async () => ({
      status: 'ok',
      text: 'Turning it off?',
      proposal: { summary: 'Off', intents: [{ intent: 'HassTurnOff', targets: ['Bedroom'], data: {}, risk: 'low' }] },
      automation: null,
      toolsUsed: [],
      numTurns: 1,
    }),
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer contract-token-0123456789abcdef' },
      body: JSON.stringify({ prompt: 'turn off the bedroom', mode: 'read', language: 'en' }),
    });
    return await res.json();
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const OVER_BOUND = {
  'the tool catalog': () => {
    answerRpc = (rpc, res) => writeOverBound(res, '{"jsonrpc":"2.0"');
  },
  'the live context': () => {
    answerRpc = (rpc, res) => (rpc.method === 'tools/list' ? defaultRpc(rpc, res) : writeOverBound(res, '{"jsonrpc":"2.0"'));
  },
  'the states list': () => {
    answerStates = (res) => writeOverBound(res, '[', STATES_BOUND_MIB);
  },
};
for (const [what, arrange] of Object.entries(OVER_BOUND)) {
  test(`someone asking past the bound of ${what} is told it is too large, not to try again`, async () => {
    arrange();
    const body = await soon(askThroughApi(), 'the answer', 30000);
    assert.equal(body.proposal, null, JSON.stringify(body));
    assert.match(body.text, /too large/);
    assert.doesNotMatch(body.text, /try again/i);
  });
}

test('a lookup past the bound is recorded as that, not as a failure', async () => {
  answerRpc = (rpc, res) => (rpc.method === 'tools/list' ? defaultRpc(rpc, res) : writeOverBound(res, '{"jsonrpc":"2.0"'));
  await assert.rejects(soon(relay.lookup('run').live('Bedroom'), 'the lookup', 30000), /too large/);
  assert.ok(recorded.some((l) => l.includes('(lookup, answer too large)')), recorded.join('\n'));
});

test('every language says too large without asking to try again', () => {
  for (const [lang, table] of Object.entries(TARGET_TEXT)) {
    assert.equal(typeof table.too_large, 'function', lang);
    const said = table.too_large();
    const retry = table.unavailable().split('. ').pop();
    assert.ok(!said.includes(retry), `${lang}: ${said}`);
    assert.ok(said.includes('Home Assistant'), `${lang}: ${said}`);
  }
});

// --- A tool that outlives its agent, and the relay.

test('an answer to an agent that left settles its call while the run is live', async () => {
  const stub = await silentHa();
  const lines = [];
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', record: (l) => lines.push(l) });
  const token = short.issue('run-live', { basenames: ['HassTurnOn'] });
  const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'HassTurnOn', arguments: {} } };
  try {
    const left = postThrough(short, token, call);
    await soon(stub.received(1), 'the request');
    left.leave();
    await settle();
    sendJson(stub.open[0], { jsonrpc: '2.0', id: 7, result: { content: [], isError: true } });
    await settle();
    assert.ok(lines.some((l) => l.includes('HassTurnOn') && l.includes('(failed)')), lines.join('\n'));
    short.revoke(token);
    assert.ok(!lines.some((l) => l.includes('(no answer)')), lines.join('\n'));
  } finally {
    short.close();
    stub.close();
  }
});

test('an answer after the run ended corrects the record, and nothing else does', async () => {
  const stub = await silentHa();
  const lines = [];
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', record: (l) => lines.push(l) });
  const token = short.issue('run-over', { basenames: ['HassTurnOn'] });
  const callOf = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'HassTurnOn', arguments: {} } });
  try {
    for (const id of [7, 8]) {
      const left = postThrough(short, token, callOf(id));
      await soon(stub.received(id - 6), 'the request');
      left.leave();
      await settle();
    }
    short.revoke(token);
    assert.equal(lines.filter((l) => l.includes('(no answer)')).length, 2, lines.join('\n'));
    sendJson(stub.open[0], { jsonrpc: '2.0', id: 7, result: { content: [] } });
    sendJson(stub.open[1], { jsonrpc: '2.0', id: 8, error: { code: 1, message: 'no' } });
    await settle();
    assert.equal(lines.filter((l) => l.includes('(answered after its run ended)')).length, 1, lines.join('\n'));
    assert.equal(lines.filter((l) => l.includes('(failed, after its run ended)')).length, 1, lines.join('\n'));
  } finally {
    short.close();
    stub.close();
  }
});

test('a tool whose answer is an event stream finishes when its agent leaves', async () => {
  const stub = await silentHa();
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', maxUnansweredRequests: 1 });
  const token = short.issue('run-sse', { basenames: ['HassTurnOn'] });
  try {
    const left = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(1), 'the request');
    stub.open[0].writeHead(200, { 'content-type': 'text/event-stream' });
    stub.open[0].write(': working\n\n');
    await soon(left.answer, 'the stream starting');
    left.leave();
    await settle();
    assert.equal(stub.open[0].destroyed, false, 'the request closed, which cancels the tool');
    // Nobody is left to read it to its end, so it holds a place again.
    assert.equal((await soon(postThrough(short, token, TOOL_CALL).answer, 'the refusal')).status, 503);
    stub.open[0].end();
    await settle();
    const next = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(2), 'the next request');
    sendJson(stub.open[1], { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal((await soon(next.answer, 'the next answer')).status, 200);
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

test('closing the relay closes what is still open, and says how many', async () => {
  const stub = await silentHa();
  const lines = [];
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', log: (l) => lines.push(l) });
  const token = short.issue('run-close', { basenames: ['HassTurnOn'] });
  try {
    const left = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(1), 'the request');
    left.leave();
    await settle();
    const closed = new Promise((resolve) => { stub.open[0].once('close', resolve); });
    short.close();
    await soon(closed, 'the request closing');
    assert.ok(lines.some((l) => l.includes('1 requests to Home Assistant still open')), lines.join('\n'));
  } finally {
    stub.close();
  }
});

test('a request whose run has ended keeps none of a tool call\'s arguments in memory', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const stub = await silentHa();
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message' });
  const token = short.issue('run-args', { basenames: ['HassTurnOn'] });
  const padded = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'HassTurnOn', arguments: { pad: 'p'.repeat(256 * 1024) } } };
  try {
    gc();
    const heapAtStart = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40; i += 1) {
      const left = postThrough(short, token, { ...padded, id: i + 1 });
      await soon(stub.received(i + 1), 'the request');
      left.leave();
      await settle();
    }
    short.revoke(token);
    await settle();
    gc();
    const kept = process.memoryUsage().heapUsed - heapAtStart;
    assert.equal(stub.open.filter((r) => !r.destroyed).length, 40, 'every request stays open');
    assert.ok(kept < 4 * MIB, `${(kept / MIB).toFixed(1)} MiB kept of 10 MiB sent`);
  } finally {
    short.close();
    stub.close();
  }
});

test('a POST with no tool in it closes when its agent leaves, and is never refused for the count', async () => {
  const stub = await silentHa();
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', maxUnansweredRequests: 1 });
  const token = short.issue('run-ping', { basenames: ['HassTurnOn'] });
  try {
    const running = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(1), 'the tool call');
    const ping = postThrough(short, token, PING);
    await soon(stub.received(2), 'the ping');
    const closed = new Promise((resolve) => { stub.open[1].once('close', resolve); });
    ping.leave();
    await soon(closed, 'the ping closing');
    running.leave();
    await settle();
    assert.equal(stub.open[0].destroyed, false, 'the tool call closed');
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

test('a partial event of a stream its agent left is not kept in memory', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const stub = await silentHa();
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message' });
  const token = short.issue('run-partial', { basenames: ['HassTurnOn'] });
  const pad = Buffer.alloc(4 * MIB, 0x7a);
  try {
    gc();
    const heapAtStart = process.memoryUsage().heapUsed;
    for (let i = 0; i < 8; i += 1) {
      const left = postThrough(short, token, TOOL_CALL);
      await soon(stub.received(i + 1), 'the request');
      stub.open[i].writeHead(200, { 'content-type': 'text/event-stream' });
      stub.open[i].write(': start\n\n');
      await soon(left.answer, 'the stream');
      stub.open[i].write('data: ');
      stub.open[i].write(pad);
      await sleep(200);
      left.leave();
      await settle();
    }
    gc();
    const kept = process.memoryUsage().heapUsed - heapAtStart;
    assert.equal(stub.open.filter((r) => !r.destroyed).length, 8, 'every request stays open');
    assert.ok(kept < 8 * MIB, `${(kept / MIB).toFixed(1)} MiB kept of 32 MiB`);
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

test('an answer to an agent that left draws on the agents\' budget, and may not stall', async () => {
  const stub = await silentHa();
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', answerStallMs: 500 });
  const token = short.issue('run-late', { basenames: ['HassTurnOn', 'GetLiveContext'] });
  try {
    const left = postThrough(short, token, TOOL_CALL);
    await soon(stub.received(1), 'the request');
    left.leave();
    await settle();
    const closed = new Promise((resolve) => { stub.open[0].once('close', resolve); });
    stub.open[0].writeHead(200, { 'content-type': 'application/json' });
    stub.open[0].write('{"pad":"');
    stub.open[0].write(Buffer.alloc(LARGE_SHARE * MIB, 0x7a));
    await settle();

    // The core's own answer of the same size has its own budget.
    const own = short.lookup('run-late').states();
    await soon(stub.received(2), 'the lookup');
    sendJson(stub.open[1], JSON.stringify([{ entity_id: 'sensor.big', attributes: { pad: 'z'.repeat(LARGE_SHARE * MIB) } }]));
    assert.equal((await soon(own, 'the lookup', 20000))[0].entity_id, 'sensor.big');
    // An agent's has not, until the stall gives it back.
    const next = postThrough(short, token, CALL);
    await soon(stub.received(3), 'the next call');
    sendJson(stub.open[2], shareBody(5));
    assert.equal((await soon(next.answer, 'the refusal', 20000)).status, 502);
    await soon(closed, 'the stalled answer closing');
    const later = postThrough(short, token, CALL);
    await soon(stub.received(4), 'the call after it');
    sendJson(stub.open[3], shareBody(5));
    assert.equal((await soon(later.answer, 'the call after it', 20000)).status, 200);
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

// --- Everything held is counted in the bytes Home Assistant sent.

const WIDE = '界';  // three bytes on the wire, one unit of a string
const wideEvent = (mib) => `data: {"jsonrpc":"2.0","id":7,"result":{"text":"${WIDE.repeat((mib * MIB) / 3)}`;

test('a partial event of wide characters past the budget ends the stream', async () => {
  answerRpc = (rpc, res) => { streamHead(res); res.write(wideEvent(BOUND_MIB + 2)); };
  const open = openAgent(CALL, SSE);
  try {
    await assert.rejects(soon(open.answered.then((res) => {
      res.resume();
      return readAll(res);
    }), 'the end of the stream', 20000));
    assert.equal(logged.filter((l) => l.includes('too large')).length, 1, logged.join('\n'));
  } finally {
    open.req.destroy();
    open.done();
  }
});

test('streams of wide characters and a JSON answer share one budget, in bytes', async () => {
  const stalled = [];
  answerRpc = (rpc, res) => {
    stalled.push(res);
    streamHead(res);
    res.write(wideEvent(6));
  };
  const first = openAgent(CALL, SSE);
  const second = openAgent(CALL, SSE);
  first.answered.catch(() => {});
  second.answered.catch(() => {});
  try {
    await sleep(500);
    assert.equal(stalled.length, 2);
    // 12 MiB held: there is no room for 6 more, though they are only 2 MiB of units each.
    const body = shareBody(5);
    answerRpc = (rpc, res) => sendJson(res, body);
    const third = await soon(agentCall(CALL), 'a JSON answer', 20000);
    assert.equal(third.status, 502);
    assert.match(third.text, /too large/);
  } finally {
    first.req.destroy();
    first.done();
    second.req.destroy();
    second.done();
  }
  await settle();
  const body = shareBody(5);
  answerRpc = (rpc, res) => sendJson(res, body);
  assert.equal((await soon(agentCall(CALL), 'the next answer', 20000)).status, 200);
});

// --- What the audit may say of an answer nobody read.

async function leftThenAnswered(answer, { revoke }) {
  const stub = await silentHa();
  const lines = [];
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', record: (l) => lines.push(l) });
  const token = short.issue('run-audit', { basenames: ['HassTurnOn'] });
  try {
    const left = postThrough(short, token, { ...TOOL_CALL, id: 7 });
    await soon(stub.received(1), 'the request');
    left.leave();
    await settle();
    if (revoke) short.revoke(token);
    sendJson(stub.open[0], JSON.stringify(answer));
    await settle();
    if (!revoke) short.revoke(token);
    return lines;
  } finally {
    short.close();
    stub.close();
  }
}
const said = (lines, mark) => lines.filter((l) => l.includes(mark)).length;
const RESULT = { jsonrpc: '2.0', id: 7, result: { content: [] } };
const FAILURE = { jsonrpc: '2.0', id: 7, error: { code: 1, message: 'no' } };

test('after its run ended a call is settled once, by the first answer', async () => {
  const lines = await leftThenAnswered([RESULT, FAILURE], { revoke: true });
  assert.equal(said(lines, '(no answer)'), 1, lines.join('\n'));
  assert.equal(said(lines, 'after its run ended'), 1, lines.join('\n'));
  assert.equal(said(lines, '(answered after its run ended)'), 1, lines.join('\n'));
});

test('while its run is live a call is settled once, and never as after the run', async () => {
  const lines = await leftThenAnswered([RESULT, RESULT], { revoke: false });
  assert.equal(said(lines, 'after its run ended'), 0, lines.join('\n'));
  assert.equal(said(lines, '(no answer)'), 0, lines.join('\n'));
  assert.equal(lines.filter((l) => l.includes('HassTurnOn')).length, 1, lines.join('\n'));
});

for (const [what, message] of [
  ['a request from the server', { jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} }],
  ['a message with neither result nor error', { jsonrpc: '2.0', id: 7 }],
  ['a message with both a method and a result', { jsonrpc: '2.0', id: 7, method: 'x', result: {} }],
]) {
  test(`${what} says nothing about how a tool ended`, async () => {
    const lines = await leftThenAnswered(message, { revoke: true });
    assert.equal(said(lines, '(no answer)'), 1, lines.join('\n'));
    assert.equal(said(lines, 'after its run ended'), 0, lines.join('\n'));
  });
}

test('the end of a run is a fact of that run, not a call missing from the record', async () => {
  // Two requests with one id: the first answer settles the call, and the second must
  // not read that as the run having ended.
  const stub = await silentHa();
  const lines = [];
  const short = await startCoreRelay({ coreOrigin: stub.url, haToken: 'ha-token-never-in-a-message', record: (l) => lines.push(l) });
  const token = short.issue('run-same-id', { basenames: ['HassTurnOn'] });
  try {
    for (let i = 0; i < 2; i += 1) {
      const left = postThrough(short, token, { ...TOOL_CALL, id: 7 });
      await soon(stub.received(i + 1), 'the request');
      left.leave();
      await settle();
    }
    sendJson(stub.open[0], RESULT);
    sendJson(stub.open[1], RESULT);
    await settle();
    assert.equal(said(lines, 'after its run ended'), 0, lines.join('\n'));
  } finally {
    short.revoke(token);
    short.close();
    stub.close();
  }
});

// --- What a resolution remembers of Home Assistant's answers is held too.

// A home of `count` devices, each its own domain, in which every lookup's answer
// carries `mib` MiB more than the device.
function largeLookups(count, mib) {
  const pad = '#'.repeat(mib * MIB);
  const device = (i) => `- names: Device ${i}\n  domain: d${i}\n  state: on\n# ${pad}\n`;
  const asked = { lookups: 0 };
  const statesOf = JSON.stringify(Array.from({ length: count }, (_, i) => ({ entity_id: `light.device_${i}`, attributes: { friendly_name: `Device ${i}` } })));
  const handle = (req, res, rpc) => {
    if (req.url === '/api/states') return sendJson(res, statesOf);
    if (rpc.method === 'tools/list') return defaultRpc(rpc, res);
    asked.lookups += 1;
    const { name, domain } = rpc.params.arguments;
    const i = Number(/(\d+)$/.exec(name || domain)[1]);
    return sendJson(res, liveAnswer(rpc.id, device(i)));
  };
  return { asked, handle };
}
const serving = (handle) => http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => handle(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null));
});

test('a resolution past what may be remembered still resolves', async () => {
  const home = largeLookups(6, 4);
  const stub = serving(home.handle);
  await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
  const short = await startCoreRelay({ coreOrigin: `http://127.0.0.1:${stub.address().port}`, haToken: 'ha-token-never-in-a-message' });
  try {
    const targets = Array.from({ length: 6 }, (_, i) => `Device ${i}`);
    const intents = [{ intent: 'HassTurnOff', targets, data: {}, risk: 'low' }];
    const out = await soon(resolveAnswer({ proposal: { summary: 'Off', intents }, automation: null }, short.lookup('run')), 'the resolution', 60000);
    assert.deepEqual(out.problems, []);
    assert.deepEqual(out.proposal.intents[0].targets, Array.from({ length: 6 }, (_, i) => `light.device_${i}`));
    assert.equal(home.asked.lookups, 18, 'three questions about each device');
  } finally {
    short.close();
    stub.close();
    stub.closeAllConnections();
  }
});

test('what a resolution remembers is given back when it ends', async () => {
  const home = largeLookups(3, 5);
  const stub = serving(home.handle);
  await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
  const short = await startCoreRelay({ coreOrigin: `http://127.0.0.1:${stub.address().port}`, haToken: 'ha-token-never-in-a-message' });
  try {
    const ask = () => {
      const lookup = short.lookup('run');
      const hold = lookup.memoryHold();
      const room = hold.take(16 * MIB);
      hold.release();
      return room;
    };
    const intents = [0, 1, 2].map((i) => ({ intent: 'HassTurnOff', targets: [`Device ${i}`], data: {}, risk: 'low' }));
    await soon(resolveAnswer({ proposal: { summary: 'Off', intents }, automation: null }, short.lookup('run')), 'the resolution', 60000);
    assert.equal(ask(), true, 'bytes were left charged');
  } finally {
    short.close();
    stub.close();
    stub.closeAllConnections();
  }
});

test('an answer arriving after the deadline refused the resolution charges nothing', async () => {
  const home = largeLookups(1, 5);
  let answerNow;
  const held = new Promise((resolve) => { answerNow = resolve; });
  const stub = serving((req, res, rpc) => held.then(() => home.handle(req, res, rpc)));
  await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
  const short = await startCoreRelay({ coreOrigin: `http://127.0.0.1:${stub.address().port}`, haToken: 'ha-token-never-in-a-message' });
  try {
    const lookup = short.lookup('run');
    let answered;
    const late = new Promise((resolve) => { answered = resolve; });
    const watched = { ...lookup, live: (name) => lookup.live(name).finally(answered) };
    const intents = [{ intent: 'HassTurnOff', targets: ['Device 0'], data: {}, risk: 'low' }];
    const out = await resolveAnswer({ proposal: { summary: 'Off', intents }, automation: null }, watched, { deadlineMs: 50 });
    assert.equal(out.problems[0].problem, 'unavailable');
    answerNow();
    await soon(late, 'the late answer', 30000);
    await new Promise(setImmediate);
    const hold = lookup.memoryHold();
    const room = hold.take(16 * MIB);
    hold.release();
    assert.equal(room, true, 'bytes were left charged');
  } finally {
    short.close();
    stub.close();
    stub.closeAllConnections();
  }
});

test('sixty names answered with 4 MiB each do not take the process down', async () => {
  const home = largeLookups(60, 4);
  const stub = serving(home.handle);
  await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
  try {
    const child = fork(path.join(__dirname, 'fixtures', 'resolve-on-small-heap.js'), [`http://127.0.0.1:${stub.address().port}`], {
      execArgv: ['--max-old-space-size=256'], silent: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.resume();
    const ended = await soon(new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); }), 'the resolution', 150000);
    assert.deepEqual(ended, { code: 0, signal: null }, 'the process died');
    assert.deepEqual(JSON.parse(out).targets, Array.from({ length: 60 }, (_, i) => `light.device_${i}`));
  } finally {
    stub.close();
    stub.closeAllConnections();
  }
});
