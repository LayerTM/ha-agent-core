'use strict';

// Whether Home Assistant accepts the add-on's token on the MCP path, as the
// relay learns it: from its own probe at start and on a timer, and from every
// answer a run or a lookup gets. Driven against a stub Core whose answer to the
// token is set per test.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startCoreRelay } = require('../server/prompt/core-relay');

const HA_TOKEN = 'ha-llat-for-the-auth-probe';

let core;
let coreOrigin;
let answer;        // the status the stub Core gives the next MCP request
let seen;          // the MCP requests the stub Core received

before(async () => {
  core = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (answer !== 200) {
        res.writeHead(answer, { 'content-type': 'text/plain' });
        res.end('no');
        return;
      }
      let id = null;
      try { id = JSON.parse(Buffer.concat(chunks).toString('utf8')).id ?? null; } catch { /* not JSON */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  coreOrigin = `http://127.0.0.1:${core.address().port}`;
});

after(() => core.close());

async function withRelay(opts, fn) {
  const lines = [];
  seen = [];
  const relay = await startCoreRelay({ coreOrigin, haToken: HA_TOKEN, log: (l) => lines.push(l), ...opts });
  try {
    await fn(relay, lines);
  } finally {
    relay.close();
  }
}

const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(cond(), 'the condition never held');
};

test('nothing is known before Home Assistant has answered', async () => {
  await withRelay({}, async (relay) => {
    assert.equal(relay.mcpAuth(), null);
    assert.equal(seen.length, 0, 'without a probe interval the relay asks nothing by itself');
  });
});

test('the probe is an MCP initialize carrying the Home Assistant token, and acts on nothing', async () => {
  answer = 200;
  await withRelay({}, async (relay) => {
    assert.equal(await relay.probeAuth(), 'ok');
    assert.equal(seen.length, 1);
    const [req] = seen;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/mcp');
    assert.equal(req.headers.authorization, `Bearer ${HA_TOKEN}`);
    assert.match(req.headers.accept, /application\/json/);
    assert.equal(JSON.parse(req.body).method, 'initialize');
  });
});

for (const status of [401, 403]) {
  test(`a ${status} is a refused token`, async () => {
    answer = status;
    await withRelay({}, async (relay, lines) => {
      assert.equal(await relay.probeAuth(), 'unauthorized');
      assert.ok(lines.some((l) => l.includes('unauthorized') && l.includes(String(status))), lines.join('\n'));
      assert.ok(!lines.some((l) => l.includes(HA_TOKEN)), 'the token is never logged');
    });
  });
}

for (const status of [404, 500, 302]) {
  test(`a ${status} says nothing about the token: unreachable, not refused`, async () => {
    answer = status;
    await withRelay({}, async (relay) => {
      assert.equal(await relay.probeAuth(), 'unreachable');
    });
  });
}

test('no answer at all is unreachable', async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));
  const relay = await startCoreRelay({ coreOrigin: origin, haToken: HA_TOKEN });
  try {
    assert.equal(await relay.probeAuth(), 'unreachable');
  } finally {
    relay.close();
  }
});

test('the start probes at once and the timer probes again, so a change shows without a chat', async () => {
  answer = 200;
  await withRelay({ authProbeEveryMs: 40 }, async (relay, lines) => {
    await until(() => relay.mcpAuth() === 'ok');
    answer = 403;
    await until(() => relay.mcpAuth() === 'unauthorized');
    answer = 200;
    await until(() => relay.mcpAuth() === 'ok');
    // A change is logged; a repeat of the same answer is not.
    const said = lines.filter((l) => l.startsWith('home assistant mcp token:'));
    assert.deepEqual(said.map((l) => l.split(' ')[4]), ['ok', 'unauthorized', 'ok']);
  });
});

test('closing the relay stops the timer', async () => {
  answer = 200;
  await withRelay({ authProbeEveryMs: 20 }, async (relay) => {
    await until(() => relay.mcpAuth() === 'ok');
  });
  const after_ = seen.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(seen.length, after_, 'no probe after close');
});

test("a run's own refused answer is the evidence: no probe needed to learn it", async () => {
  answer = 200;
  await withRelay({}, async (relay) => {
    await relay.probeAuth();
    const bearer = relay.issue('run-1', { basenames: ['GetLiveContext'] });
    answer = 401;
    const res = await fetch(`${relay.url}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(res.status, 401);
    assert.equal(relay.mcpAuth(), 'unauthorized');
    answer = 200;
    const again = await fetch(`${relay.url}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
      body: '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    });
    assert.equal(again.status, 200);
    assert.equal(relay.mcpAuth(), 'ok', 'an accepted answer after a refusal says the token works again');
  });
});

test("a run's answer that says nothing about the token leaves the state as it was", async () => {
  answer = 200;
  await withRelay({}, async (relay) => {
    await relay.probeAuth();
    const bearer = relay.issue('run-2', { basenames: ['GetLiveContext'] });
    answer = 405;
    const res = await fetch(`${relay.url}/api/mcp`, { headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(res.status, 405);
    assert.equal(relay.mcpAuth(), 'ok');
  });
});

test("a lookup's refused answer is evidence too", async () => {
  answer = 403;
  await withRelay({}, async (relay) => {
    await assert.rejects(relay.lookup('run-3').live('kitchen'));
    assert.equal(relay.mcpAuth(), 'unauthorized');
  });
});
