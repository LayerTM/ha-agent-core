'use strict';

// Warm sessions (session-pool.js) driven through the core's run(): the neutral
// agent in session mode plays one tape per turn, and the pool's hooks record
// what a real relay would be told.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CLAUDE_PROMPT_TIMEOUT_MS = '10000';

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter, okTape } = require('../fixtures/neutral-adapter');

const { adapter, state, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const core = require('../../server/prompt/run');
const { createSessionPool } = require('../../server/prompt/session-pool');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-session-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let hooks;
let pools;
const logs = [];
function newPool(opts = {}) {
  const pool = createSessionPool({ hooks, log: (m) => logs.push(m), resetMs: 500, ...opts });
  pools.push(pool);
  return pool;
}

beforeEach(() => {
  for (const p of pools || []) p.shutdown();
  pools = [];
  logs.length = 0;
  state.stableArgs = true;
  state.turnTapes.length = 0;
  state.tapes.length = 0;
  state.sessionAgent = {};
  state.sessionLaunches.length = 0;
  let n = 0;
  hooks = {
    opened: [], closed: [], binds: [], unbinds: [],
    async open() {
      n += 1;
      const handle = { token: `session-${n}`, mcpConfigPath: path.join(TMP, `session-${n}.json`), dir: null };
      this.opened.push(handle);
      return handle;
    },
    async close(handle) { this.closed.push(handle.token); },
    bind(token, runToken) { this.binds.push([token, runToken]); return true; },
    unbind(token) { this.unbinds.push(token); },
  };
});

let runs = 0;
function read(pool, opts = {}) {
  runs += 1;
  const { caller = 'caller-1', ...rest } = opts;
  return core.run({
    bin: process.execPath, prompt: `hello ${runs}`, cwd: TMP,
    // Every run has its own configuration file, as the core gives it: the
    // session must still be shared.
    mcpConfigPath: path.join(TMP, `run-${runs}.json`),
    warm: pool ? { pool, caller, runToken: `run-${runs}` } : null,
    ...rest,
  });
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}
const ready = (pool) => until(() => pool.states().includes('ready'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('with no pool no session is ever started', async () => {
  assert.equal((await read(null)).status, 'ok');
  assert.equal((await read(null)).status, 'ok');
  assert.equal(state.sessionLaunches.length, 0);
});

test('a read like the one before it is served warm, by one session, bound only for its turn', async () => {
  const pool = newPool();
  const first = await read(pool);
  assert.equal(first.status, 'ok');
  assert.equal(first.warm, undefined, 'the first read runs fresh');
  assert.equal(await ready(pool), true, 'it started a session for the next reads');
  for (let i = 0; i < 3; i += 1) {
    state.turnTapes.push([{ echo: 'stdin' }]);
    // eslint-disable-next-line no-await-in-loop
    const warm = await read(pool);
    assert.equal(warm.status, 'ok');
    assert.equal(warm.warm, true);
    assert.equal(warm.text, `hello ${runs}`, 'the turn got its own prompt');
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await ready(pool), true, 'reset and ready again');
  }
  assert.equal(state.sessionLaunches.length, 1, 'one session served them all');
  assert.equal(hooks.binds.length, 3);
  assert.deepEqual(hooks.binds.map(([, r]) => r), [`run-${runs - 2}`, `run-${runs - 1}`, `run-${runs}`]);
  assert.ok(hooks.unbinds.length >= 3, 'every turn was unbound at its end');
  assert.equal(state.sessionLaunches[0].mcpConfigPath, hooks.opened[0].mcpConfigPath, 'the session reads its own config');
});

test('nothing of one turn reaches the next — and the instrument can see it when it does', async () => {
  const pool = newPool();
  await read(pool);
  await ready(pool);
  state.turnTapes.push([{ echo: 'stdin' }], [{ echo: 'memory' }]);
  await read(pool, { prompt: 'The code word is ZEBRA-41.' });
  await ready(pool);
  const next = await read(pool, { prompt: 'Quote the code word.' });
  assert.equal(next.warm, true);
  assert.equal(next.text, '', 'the reset forgot the turn before');

  // Control: a session agent that confirms the reset but remembers. The same
  // two turns show the leak, so the assertion above measures something.
  pool.shutdown();
  state.sessionAgent = { forget: false };
  const control = newPool();
  await read(control);
  await ready(control);
  state.turnTapes.push([{ echo: 'stdin' }], [{ echo: 'memory' }]);
  await read(control, { prompt: 'The code word is ZEBRA-41.' });
  await ready(control);
  const leaked = await read(control, { prompt: 'Quote the code word.' });
  assert.match(leaked.text, /ZEBRA-41/);
});

test('a session that does not complete its reset is ended, and the next read runs fresh', async () => {
  state.sessionAgent = { honourClear: false };
  const pool = newPool({ resetMs: 200 });
  await read(pool);
  assert.equal(await until(() => hooks.opened.length === 1), true);
  assert.equal(await until(() => pool.size() === 0 && hooks.closed.length === 1), true, 'killed and its bearer closed');
  assert.ok(logs.some((l) => /reset did not complete/.test(l)), logs.join('\n'));
  const next = await read(pool);
  assert.equal(next.warm, undefined);
  assert.equal(hooks.binds.length, 0, 'no turn was ever written to it');
});

test('what a turn writes after its answer never reaches the next turn', async () => {
  const pool = newPool();
  await read(pool, { onText: () => {} });
  await ready(pool);
  state.turnTapes.push([
    { emit: { type: 'result', structured: { text: 'one', proposal: null, automation: null } } },
    { emit: { type: 'fragment-start' } },
    { emit: { type: 'fragment', json: '{"text":"LEAK-131' } },
  ], [
    { emit: { type: 'fragment-start' } },
    { emit: { type: 'fragment', json: '{"text":"two' } },
    { emit: { type: 'result', structured: { text: 'two', proposal: null, automation: null } } },
  ]);
  const one = await read(pool, { onText: () => {} });
  assert.equal(one.text, 'one');
  await ready(pool);
  const seen = [];
  const two = await read(pool, { onText: (t) => seen.push(t) });
  assert.equal(two.warm, true);
  assert.equal(two.text, 'two');
  assert.deepEqual(seen, ['two']);
});

test('another caller, model or surface never shares a session', async () => {
  const pool = newPool({ cap: 4 });
  await read(pool);
  await ready(pool);
  const other = await read(pool, { caller: 'caller-2' });
  assert.equal(other.warm, undefined, 'another caller runs fresh');
  const model = await read(pool, { model: 'm2' });
  assert.equal(model.warm, undefined, 'another model runs fresh');
  const voice = await read(pool, { surface: 'voice' });
  assert.equal(voice.warm, undefined, 'another surface runs fresh');
  assert.equal(await until(() => state.sessionLaunches.length === 4), true, 'each started its own session');
});

test('a timeout, an abort or a renamed tool ends the session; the next read runs fresh', async () => {
  const cases = [
    ['timeout', [{ hang: true }], { timeoutMs: 1000 }, 'timeout'],
    ['abort', [{ hang: true }], 'abort', 'aborted'],
    ['mismatch', [{ emit: { type: 'init', mcpConnected: true, tools: ['ha.homeassistant__GetLiveContext'] } }, { sleep: 500 }],
      {}, 'tool-name-mismatch'],
    ['exit', [{ exit: 3 }], {}, 'no-result'],
  ];
  for (const [label, tape, opts, expect] of cases) {
    const pool = newPool();
    // eslint-disable-next-line no-await-in-loop
    await read(pool);
    // eslint-disable-next-line no-await-in-loop
    await ready(pool);
    const pidFile = path.join(TMP, `session-pid-${label}`);
    state.turnTapes.push([{ pid: pidFile }, ...tape]);
    let outcome;
    if (opts === 'abort') {
      const abort = new AbortController();
      const pending = read(pool, { signal: abort.signal });
      // eslint-disable-next-line no-await-in-loop
      await until(() => fs.existsSync(pidFile));
      abort.abort();
      // eslint-disable-next-line no-await-in-loop
      outcome = await pending;
    } else {
      // eslint-disable-next-line no-await-in-loop
      outcome = await read(pool, opts);
    }
    assert.equal(outcome.status === 'timeout' ? 'timeout' : outcome.reason, expect, label);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await until(() => !alive(pid)), true, `${label}: the session process is still running`);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await until(() => pool.size() === 0), true, `${label}: still in the pool`);
    assert.ok(hooks.unbinds.length > 0, `${label}: never unbound`);
    // eslint-disable-next-line no-await-in-loop
    const next = await read(pool);
    assert.equal(next.warm, undefined, `${label}: the next read ran warm`);
    pool.shutdown();
  }
});

test('a session is recycled after its turns, when idle, past its context, and the pool has a cap', async () => {
  const turns = newPool({ maxTurns: 2 });
  await read(turns);
  await ready(turns);
  assert.equal((await read(turns)).warm, true);
  await ready(turns);
  assert.equal((await read(turns)).warm, true);
  assert.equal(await until(() => turns.size() === 0), true, 'ended after 2 turns');
  assert.ok(logs.some((l) => /served 2 turns/.test(l)));

  const idle = newPool({ idleMs: 150 });
  await read(idle);
  await ready(idle);
  assert.equal(await until(() => idle.size() === 0), true, 'ended when idle');

  const grow = newPool({ contextGrowth: 1000 });
  await read(grow);
  await ready(grow);
  state.turnTapes.push(
    [{ emit: { type: 'result', structured: { text: 'a', proposal: null, automation: null }, tokens: [{ model: 'm', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }] } }],
    [{ emit: { type: 'result', structured: { text: 'b', proposal: null, automation: null }, tokens: [{ model: 'm', input: 5000, output: 1, cacheRead: 0, cacheWrite: 0 }] } }],
  );
  await read(grow);
  await ready(grow);
  await read(grow);
  assert.equal(await until(() => grow.size() === 0), true, 'ended when its context kept growing');

  const capped = newPool({ cap: 1 });
  await read(capped, { caller: 'a' });
  await ready(capped);
  await read(capped, { caller: 'b' });
  assert.equal(await until(() => state.sessionLaunches.length >= 5 && capped.size() === 1), true);
  assert.ok(logs.some((l) => /pool is full/.test(l)), 'the idle session was evicted for the new one');
});

test('shutdown ends every session', async () => {
  const pool = newPool();
  await read(pool);
  await ready(pool);
  pool.shutdown();
  assert.equal(pool.size(), 0);
  assert.equal(await until(() => hooks.closed.length === 1), true);
  // A pool that is shut down starts nothing.
  await read(pool);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hooks.opened.length, 1);
});

test('the okTape fixture still answers a fresh read', async () => {
  state.tapes.push(okTape('fresh'));
  assert.equal((await read(null)).text, 'fresh');
});

// --- the engine check an add-on runs on every engine update ------------------------

test('the session check passes on an engine that resets, and fails on one that does not', async () => {
  const { main } = require('../../server/prompt/session-check');
  const quiet = console.log;
  const loud = console.error;
  const said = [];
  console.log = (m) => said.push(m);
  console.error = (m) => said.push(m);
  try {
    state.sessionAgent = {};
    assert.equal(await main(['--bin', process.execPath]), 0, said.join('\n'));
    state.sessionAgent = { honourClear: false };
    assert.equal(await main(['--bin', process.execPath]), 1);
    assert.match(said.pop(), /reset 1 did not complete/);
  } finally {
    console.log = quiet;
    console.error = loud;
  }
});
