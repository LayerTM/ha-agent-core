'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { check, write, RECORD } = require('../tools/check-install-scripts.js');
const { tempDir } = require('./helpers.js');

const CHECKER = path.join(__dirname, '..', 'tools', 'check-install-scripts.js');

function put(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/**
 * A project that allows one package with a native build, installed.
 * @param {import('node:test').TestContext} t
 * @param {{ allow?: Record<string, boolean>, scripts?: Record<string, string> }} [options]
 */
function project(t, { allow = { native: true }, scripts } = {}) {
  const dir = tempDir(t);
  put(dir, 'package.json', { name: 'app', dependencies: { native: '1.0.0', plain: '1.0.0' }, allowScripts: allow });
  put(dir, 'package-lock.json', {
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/native': { version: '1.0.0' }, 'node_modules/plain': { version: '1.0.0' } },
  });
  put(dir, 'node_modules/native/package.json', {
    name: 'native',
    version: '1.0.0',
    scripts: scripts || { install: 'node scripts/build.js || node-gyp rebuild', test: 'node scripts/unrelated.js' },
  });
  put(dir, 'node_modules/native/scripts/build.js', "require('./lib/helper');\nrequire('fs');\n");
  put(dir, 'node_modules/native/scripts/lib/helper.js', 'module.exports = 1;\n');
  put(dir, 'node_modules/native/scripts/unrelated.js', 'console.log(1);\n');
  put(dir, 'node_modules/native/binding.gyp',
    "{ 'targets': [{ 'include_dirs': ['<!(node -p \\\"require(\\'addon\\').dir\\\")', '<!(node -p \\\"require('fs').x\\\")'] }] }\n");
  put(dir, 'node_modules/addon/package.json', { name: 'addon', version: '2.0.0', main: 'lib/main.js' });
  put(dir, 'node_modules/addon/lib/main.js', "require('./util');\nrequire('deep/part');\nrequire('node:path');\nrequire('missing-pkg');\n");
  put(dir, 'node_modules/addon/lib/util.js', 'module.exports = 2;\n');
  put(dir, 'node_modules/addon/addon.gyp', '{}\n');
  put(dir, 'node_modules/addon/tools/unused.js', 'never loaded\n');
  put(dir, 'node_modules/deep/package.json', { name: 'deep', version: '1.0.0' });
  put(dir, 'node_modules/deep/part.js', 'module.exports = 3;\n');
  put(dir, 'node_modules/deep/index.js', 'not the part that is loaded\n');
  put(dir, 'node_modules/native/deps/extra.gypi', '{}\n');
  put(dir, 'node_modules/native/src/native.cc', 'int x;\n');
  put(dir, 'node_modules/plain/package.json', { name: 'plain', version: '1.0.0' });
  return dir;
}

function edit(dir, rel, fn) {
  const file = path.join(dir, rel);
  fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
}

function editJson(dir, rel, fn) {
  edit(dir, rel, (text) => `${JSON.stringify(fn(JSON.parse(text)), null, 2)}\n`);
}

test('an allowed package must be reviewed, and a recorded one is then clean', (t) => {
  const dir = project(t);
  assert.deepEqual(check(dir).problems, [`native: allowed in allowScripts but not reviewed in ${RECORD}`]);
  assert.deepEqual(write(dir).problems, []);
  const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
  assert.deepEqual(record.native.scripts, { install: 'node scripts/build.js || node-gyp rebuild' });
  assert.deepEqual(Object.keys(record.native.files), [
    'binding.gyp', 'deps/extra.gypi',
    'node_modules/addon/addon.gyp', 'node_modules/addon/lib/main.js', 'node_modules/addon/lib/util.js',
    'node_modules/deep/part.js',
    'scripts/build.js', 'scripts/lib/helper.js',
    'unresolved:missing-pkg',
  ]);
  assert.match(record.native.files['scripts/build.js'], /^[0-9a-f]{64}$/);
  assert.deepEqual(check(dir).problems, []);
});

test('a version bump that runs the same install step stays clean', (t) => {
  const dir = project(t);
  write(dir);
  editJson(dir, 'node_modules/native/package.json', (p) => ({ ...p, version: '1.1.0', scripts: { ...p.scripts, test: 'other' } }));
  edit(dir, 'node_modules/native/src/native.cc', () => 'int y;\n');
  edit(dir, 'node_modules/native/scripts/unrelated.js', () => 'changed\n');
  edit(dir, 'node_modules/addon/tools/unused.js', () => 'changed\n');
  edit(dir, 'node_modules/deep/index.js', () => 'changed\n');
  editJson(dir, 'node_modules/addon/package.json', (p) => ({ ...p, version: '2.0.1' }));
  // What the build itself writes is output, not input.
  put(dir, 'node_modules/native/build/config.gypi', '{ "generated": 1 }\n');
  put(dir, 'node_modules/native/build/Release/native.node', 'binary');
  assert.deepEqual(check(dir).problems, []);
});

test('each change to what the install step runs is named', (t) => {
  /** @type {Array<[string, (dir: string) => void, RegExp]>} */
  const cases = [
    ['the script file', (d) => edit(d, 'node_modules/native/scripts/build.js', (s) => `${s}// more\n`),
      /^native@1\.0\.0: review scripts\/build\.js, changed since 1\.0\.0$/],
    ['a file it requires', (d) => edit(d, 'node_modules/native/scripts/lib/helper.js', () => 'evil();\n'),
      /review scripts\/lib\/helper\.js, changed since/],
    ['the gyp file', (d) => edit(d, 'node_modules/native/binding.gyp', () => "{ 'actions': [] }\n"),
      /review binding\.gyp, changed since/],
    ['a nested gypi', (d) => edit(d, 'node_modules/native/deps/extra.gypi', () => '{ }\n'),
      /review deps\/extra\.gypi, changed since/],
    ['a package the gyp file loads', (d) => edit(d, 'node_modules/addon/lib/main.js', (s) => `${s}evil();\n`),
      /review node_modules\/addon\/lib\/main\.js, changed since/],
    ['a file that package loads', (d) => edit(d, 'node_modules/addon/lib/util.js', () => 'evil();\n'),
      /review node_modules\/addon\/lib\/util\.js, changed since/],
    ['a package loaded from there', (d) => edit(d, 'node_modules/deep/part.js', () => 'evil();\n'),
      /review node_modules\/deep\/part\.js, changed since/],
    ['a gyp file of that package', (d) => edit(d, 'node_modules/addon/addon.gyp', () => "{ 'actions': [] }\n"),
      /review node_modules\/addon\/addon\.gyp, changed since/],
    ['a package that now resolves', (d) => {
      put(d, 'node_modules/missing-pkg/index.js', 'x');
      put(d, 'node_modules/missing-pkg/package.json', { name: 'missing-pkg' });
    },
      /review node_modules\/missing-pkg\/index\.js, newly run at install/],
    ['the command', (d) => editJson(d, 'node_modules/native/package.json', (p) => ({ ...p, scripts: { install: 'node-gyp rebuild && curl x' } })),
      /the install script changed: "node scripts\/build\.js \|\| node-gyp rebuild" -> "node-gyp rebuild && curl x"/],
  ];
  for (const [label, change, expected] of cases) {
    const dir = project(t);
    write(dir);
    change(dir);
    const { problems } = check(dir);
    assert.ok(problems.some((p) => expected.test(p)), `${label}: ${JSON.stringify(problems)}`);
  }
});

test('a new lifecycle script and the file it runs are both named', (t) => {
  const dir = project(t);
  write(dir);
  put(dir, 'node_modules/native/scripts/after.js', 'fetch("x");\n');
  editJson(dir, 'node_modules/native/package.json', (p) => ({ ...p, scripts: { ...p.scripts, postinstall: 'node ./scripts/after' } }));
  assert.deepEqual(check(dir).problems, [
    'native@1.0.0: the postinstall script changed: null -> "node ./scripts/after"',
    'native@1.0.0: review scripts/after.js, newly run at install',
  ]);
});

test('a package without install scripts but with binding.gyp builds implicitly', (t) => {
  const dir = project(t, { scripts: {} });
  write(dir);
  const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
  assert.deepEqual(record.native.scripts, { install: 'node-gyp rebuild' });
  assert.deepEqual(Object.keys(record.native.files).filter((k) => !k.startsWith('node_modules/') && !k.startsWith('unresolved:')),
    ['binding.gyp', 'deps/extra.gypi']);
});

test('the allow list and the record must name the same packages', (t) => {
  const dir = project(t);
  write(dir);
  editJson(dir, 'package.json', (p) => ({ ...p, allowScripts: { native: false } }));
  assert.deepEqual(check(dir).problems, [`native: recorded in ${RECORD} but not allowed in allowScripts`]);

  editJson(dir, 'package.json', (p) => ({ ...p, allowScripts: { native: true, missing: true } }));
  assert.deepEqual(check(dir).problems, ['missing: allowed in allowScripts but not in package-lock.json']);
});

test('a version-pinned entry is refused: the fingerprint is the pin', (t) => {
  const dir = project(t, { allow: { 'native@1.0.0': true } });
  assert.match(write(dir).problems[0], /allowScripts entry "native@1\.0\.0" is not a bare package name/);
  assert.equal(fs.existsSync(path.join(dir, RECORD)), false, 'nothing recorded while there are problems');
});

test('the command line reports, exits and suggests the record step', (t) => {
  const dir = project(t);
  const run = (...args) => spawnSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8' });
  let r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not reviewed/);
  assert.match(r.stderr, /--write/);
  r = run(dir, '--write');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'install scripts: recorded (native)\n');
  r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'install scripts: as reviewed (native)\n');
  const verdict = path.join(dir, 'verdict.json');
  r = run(dir, '--verdict', verdict);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(verdict, 'utf8')), { reviewed: true, findings: [] });
  edit(dir, 'node_modules/native/binding.gyp', (s) => `${s} `);
  r = run(dir, '--verdict', verdict);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(verdict, 'utf8')), {
    reviewed: false, findings: ['native@1.0.0: review binding.gyp, changed since 1.0.0'],
  });
  assert.equal(run(dir, '--verdict').status, 2);
  assert.equal(run(dir, '--write', '--verdict', verdict).status, 2);
  assert.equal(run().status, 2);
  assert.equal(run(path.join(dir, 'nowhere')).status, 2);
  assert.equal(run(dir, dir).status, 2);
});

test('the core records what its own allowed install scripts run', () => {
  const app = path.join(__dirname, '..', 'app');
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  const record = JSON.parse(fs.readFileSync(path.join(app, RECORD), 'utf8'));
  const allowed = Object.keys(pkg.allowScripts).filter((name) => pkg.allowScripts[name] === true);
  assert.deepEqual(Object.keys(record).sort(), allowed.sort());
});
