'use strict';

// The console API routes that drive tmux and the engine's own commands, with
// no engine and no tmux installed. A recording `tmux` is put first on PATH; the
// engine's launcher, updater and binary come from the neutral adapter. What the
// core owns is asserted here: which tmux call each route makes, that the
// engine's names come from the adapter, input validation, and the error shape.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-console-api-'));
const BIN = path.join(TMP, 'bin');
const TMUX_LOG = path.join(TMP, 'tmux.log');
const TMUX_FAIL = path.join(TMP, 'tmux.fail');

// One line per call: the arguments joined by a unit separator. A call fails
// (exit 1, stderr "tmux: refused") while TMUX_FAIL exists.
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'tmux'), `#!/bin/sh
( IFS="$(printf '\\037')"; printf '%s\\n' "$*" ) >> "${TMUX_LOG}"
if [ -e "${TMUX_FAIL}" ]; then echo 'tmux: refused' >&2; exit 1; fi
case "$1" in
  capture-pane) printf 'first line\\nlast line   \\n\\n\\n' ;;
  list-windows) printf '0\\tagent\\n3\\tshell\\n' ;;
  new-window) printf '3\\n' ;;
esac
exit 0
`, { mode: 0o755 });
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
process.env.CC_OPTIONS_PATH = path.join(TMP, 'options.json');
process.env.CC_ALERTS_STATE_PATH = path.join(TMP, 'alerts-state.json');
delete process.env.SUPERVISOR_TOKEN;

const { adapter: neutral, branding: neutralBranding } = require('../fixtures/neutral-adapter').createNeutralAdapter();
require('../../server/adapter-contract').useAdapter(neutral, neutralBranding);

const express = require('express');
const { createRouter } = require('../../server/api');

let BASE = '';
let server;

const tmuxCalls = () => {
  if (!fs.existsSync(TMUX_LOG)) return [];
  return fs.readFileSync(TMUX_LOG, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f'));
};
const call = (method, p, body) => fetch(`${BASE}${p}`, {
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const TABS = [{ index: 0, name: 'agent' }, { index: 3, name: 'shell' }];

before(async () => {
  const app = express();
  app.use('/api', createRouter({ uploadDir: TMP }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  BASE = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(TMUX_LOG, { force: true });
  fs.rmSync(TMUX_FAIL, { force: true });
});

test('GET /capture returns the pane as text, trailing blank space folded to one newline', async () => {
  const r = await call('GET', '/capture?window=3&lines=200');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.equal(await r.text(), 'first line\nlast line\n');
  assert.deepEqual(tmuxCalls(), [['capture-pane', '-p', '-J', '-t', 'main:3', '-S', '-200']]);
});

test('GET /capture defaults to window 0 and the visible pane, and caps the history', async () => {
  await call('GET', '/capture');
  await call('GET', '/capture?window=1&lines=999999');
  assert.deepEqual(tmuxCalls(), [
    ['capture-pane', '-p', '-J', '-t', 'main:0'],
    ['capture-pane', '-p', '-J', '-t', 'main:1', '-S', '-50000'],
  ]);
});

test('GET /capture refuses a window that is not a non-negative integer, without calling tmux', async () => {
  for (const w of ['-1', 'x', '']) {
    const r = await call('GET', `/capture?window=${w}`);
    assert.equal(r.status, 400, `window=${w}`);
    assert.deepEqual(await r.json(), { error: 'invalid window' });
  }
  assert.deepEqual(tmuxCalls(), []);
});

test('GET /capture reports a tmux failure as 500 with its stderr', async () => {
  fs.writeFileSync(TMUX_FAIL, '');
  const r = await call('GET', '/capture?window=0');
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /tmux: refused/);
});

test('POST /tabs opens a login shell window and returns its index and the tab list', async () => {
  const r = await call('POST', '/tabs');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { index: 3, tabs: TABS });
  const [created] = tmuxCalls();
  assert.deepEqual(created.slice(0, 5), ['new-window', '-d', '-t', 'main', '-n']);
  assert.deepEqual(created.slice(-2), ['bash', '-l']);
});

test('POST /tabs reports a tmux failure as 500', async () => {
  fs.writeFileSync(TMUX_FAIL, '');
  const r = await call('POST', '/tabs');
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /tmux: refused/);
});

test('DELETE /tabs/:index closes that window and returns the tab list', async () => {
  const r = await call('DELETE', '/tabs/3');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { tabs: TABS });
  assert.deepEqual(tmuxCalls()[0], ['kill-window', '-t', 'main:3']);
});

test('DELETE /tabs/:index refuses an invalid index without calling tmux, and reports a failure as 400', async () => {
  const bad = await call('DELETE', '/tabs/-2');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'invalid window' });
  assert.deepEqual(tmuxCalls(), []);
  fs.writeFileSync(TMUX_FAIL, '');
  const failed = await call('DELETE', '/tabs/3');
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /tmux: refused/);
});

test('POST /claude/respawn restarts the agent window with the adapter\'s launcher', async () => {
  const r = await call('POST', '/claude/respawn');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(tmuxCalls(), [['respawn-window', '-k', '-t', 'main:0', neutral.console.launcher]]);
});

test('POST /claude/respawn reports a tmux failure as 500', async () => {
  fs.writeFileSync(TMUX_FAIL, '');
  const r = await call('POST', '/claude/respawn');
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /tmux: refused/);
});

// An engine whose version is whatever the updater last wrote, and an updater
// that records its arguments and fails when asked to.
function fakeEngine(t) {
  const dir = fs.mkdtempSync(path.join(TMP, 'engine-'));
  const version = path.join(dir, 'version');
  const args = path.join(dir, 'args');
  fs.writeFileSync(version, '1.0.0');
  fs.writeFileSync(path.join(dir, 'agent'), `#!/bin/sh\nprintf 'neutral-agent %s\\n' "$(cat '${version}')"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'update'), `#!/bin/sh
printf '%s\\n' "$#:$*" > '${args}'
if [ "$1" = 9.9.9 ]; then echo 'no such version' >&2; exit 3; fi
printf '2.0.0' > '${version}'
echo updated
`, { mode: 0o755 });
  const saved = { bin: neutral.console.bin, updateCommand: neutral.console.updateCommand };
  neutral.console.bin = path.join(dir, 'agent');
  neutral.console.updateCommand = path.join(dir, 'update');
  t.after(() => Object.assign(neutral.console, saved));
  return { args: () => fs.readFileSync(args, 'utf8') };
}

test('POST /cli/update runs the adapter\'s updater and reports the version before and after', async (t) => {
  const engine = fakeEngine(t);
  const r = await call('POST', '/cli/update', {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { before: '1.0.0', after: '2.0.0', changed: true, output: 'updated\n' });
  assert.equal(engine.args(), '0:\n', 'no target → no argument');
});

test('POST /cli/update passes a valid target as the one argument', async (t) => {
  const engine = fakeEngine(t);
  for (const target of ['stable', 'latest', '2.0.0', ' 2.1.0-beta.1 ']) {
    assert.equal((await call('POST', '/cli/update', { target })).status, 200, target);
    assert.equal(engine.args(), `1:${target.trim()}\n`);
  }
});

test('POST /cli/update refuses a target that is not a channel or a version, without running anything', async (t) => {
  const engine = fakeEngine(t);
  for (const target of ['--help', 'v2', '1.0; rm -rf /', 'next']) {
    const r = await call('POST', '/cli/update', { target });
    assert.equal(r.status, 400, target);
    assert.deepEqual(await r.json(), { error: 'invalid target' });
  }
  assert.throws(() => engine.args(), { code: 'ENOENT' });
});

test('POST /cli/update reports a failed updater as 500 with its output, the version unchanged', async (t) => {
  fakeEngine(t);
  const r = await call('POST', '/cli/update', { target: '9.9.9' });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { before: '1.0.0', after: '1.0.0', changed: false, output: 'no such version\n' });
});

test('POST /upload saves each file under a unique sanitised name', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'uploads-'));
  const app = express();
  app.use('/api', createRouter({ uploadDir: dir }));
  const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const form = new FormData();
    form.append('file', new Blob(['hello']), '../../etc/pass wd.txt');
    form.append('file', new Blob(['hello']), '../../etc/pass wd.txt');
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/upload`, { method: 'POST', body: form });
    assert.equal(r.status, 200);
    const { files } = await r.json();
    assert.equal(files.length, 2);
    assert.notEqual(files[0].name, files[1].name);
    for (const f of files) {
      assert.match(f.name, /^\d{8}-\d{6}-[0-9a-f]{6}-pass_wd\.txt$/);
      assert.equal(path.dirname(f.path), dir);
      assert.equal(f.size, 5);
      assert.equal(fs.readFileSync(f.path, 'utf8'), 'hello');
    }
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('POST /upload with no files is a 400', async () => {
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: new FormData() });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});
