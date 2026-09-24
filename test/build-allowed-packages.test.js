'use strict';

// The allowed install scripts run in a staging directory that holds only their
// reviewed closure. Driven with the real npm, offline, on a hand-made install:
// an allowed package whose install script calls a bare `node-gyp`, and a package
// outside its closure that puts its own `node-gyp` in node_modules/.bin.

const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { write } = require('../tools/check-install-scripts.js');
const { tempDir } = require('./helpers.js');

const BUILDER = path.join(__dirname, '..', 'tools', 'build-allowed-packages.js');
const NPM_CLI = fs.realpathSync(execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim());
const REG = 'https://registry.npmjs.org';
const integrity = (seed) => `sha512-${Buffer.alloc(64, seed).toString('base64')}`;

function put(dir, rel, content, mode) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content), mode ? { mode } : {});
}

/** @param {import('node:test').TestContext} t */
function installed(t) {
  const dir = tempDir(t);
  const marker = path.join(dir, 'shadow-ran');
  put(dir, 'package.json', { name: 'app', dependencies: { native: '1.0.0', shadow: '1.0.0' }, allowScripts: { native: true } });
  put(dir, 'package-lock.json', {
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { native: '1.0.0', shadow: '1.0.0' } },
      'node_modules/native': {
        version: '1.0.0', resolved: `${REG}/native/-/native-1.0.0.tgz`, integrity: integrity(1),
        hasInstallScript: true, dependencies: { helper: '1.0.0' },
      },
      'node_modules/helper': { version: '1.0.0', resolved: `${REG}/helper/-/helper-1.0.0.tgz`, integrity: integrity(2) },
      'node_modules/shadow': {
        version: '1.0.0', resolved: `${REG}/shadow/-/shadow-1.0.0.tgz`, integrity: integrity(3), bin: { 'node-gyp': 'cli.js' },
      },
    },
  });
  // The allowed package: its install step asks the PATH for node-gyp, then
  // records which one answered and what the build produced.
  put(dir, 'node_modules/native/package.json', {
    name: 'native', version: '1.0.0', dependencies: { helper: '1.0.0' },
    scripts: { install: 'node-gyp --version > gyp-version.txt && node build.js' },
  });
  put(dir, 'node_modules/native/build.js',
    "const fs = require('fs'); fs.mkdirSync('build/Release', { recursive: true });\n"
    + "fs.writeFileSync('build/Release/out.txt', require('helper'));\n");
  put(dir, 'node_modules/helper/package.json', { name: 'helper', version: '1.0.0' });
  put(dir, 'node_modules/helper/index.js', "module.exports = 'built';\n");
  // Outside the closure: a bin named node-gyp.
  put(dir, 'node_modules/shadow/package.json', { name: 'shadow', version: '1.0.0', bin: { 'node-gyp': 'cli.js' } });
  put(dir, 'node_modules/shadow/cli.js',
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nconsole.log('shadow');\n`, 0o755);
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'));
  fs.symlinkSync('../shadow/cli.js', path.join(dir, 'node_modules', '.bin', 'node-gyp'));
  // Nested under the allowed package but not its declared dependency, so not in
  // the closure either; npm would put its .bin first on the script's PATH.
  put(dir, 'node_modules/native/node_modules/nested/package.json', { name: 'nested', version: '1.0.0', bin: { 'node-gyp': 'cli.js' } });
  put(dir, 'node_modules/native/node_modules/nested/cli.js',
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'nested');\nconsole.log('nested');\n`, 0o755);
  fs.mkdirSync(path.join(dir, 'node_modules', 'native', 'node_modules', '.bin'));
  fs.symlinkSync('../nested/cli.js', path.join(dir, 'node_modules', 'native', 'node_modules', '.bin', 'node-gyp'));
  assert.deepEqual(write(dir).problems, []);
  return { dir, marker };
}

const npm = (dir, ...args) => spawnSync(process.execPath, [NPM_CLI, ...args], { cwd: dir, encoding: 'utf8' });
const build = (dir, env = {}, args = []) => spawnSync(process.execPath, [BUILDER, ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, NPM_CLI, ...env },
});

test('control: a rebuild in the install directory runs the shadowing node-gyp', (t) => {
  const { dir, marker } = installed(t);
  const r = npm(dir, 'rebuild', '--strict-allow-scripts');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), true, 'the probe is live');
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules/native/gyp-version.txt'), 'utf8').trim(), 'nested');
});

test('the staged build reaches only the closure, and its output comes back', (t) => {
  const { dir, marker } = installed(t);
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), false, 'the package outside the closure did not run');
  assert.match(fs.readFileSync(path.join(dir, 'node_modules/native/gyp-version.txt'), 'utf8'), /^v\d+\.\d+\.\d+/,
    'the node-gyp that answered is npm\'s own');
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules/native/build/Release/out.txt'), 'utf8'), 'built');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules/shadow/cli.js')), true, 'the rest of the install is untouched');
});

test('an unreviewed install is not built unless the untrusted test build is asked for', (t) => {
  const { dir } = installed(t);
  fs.rmSync(path.join(dir, 'install-scripts.json'));
  let r = build(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not reviewed/);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules/native/build')), false);
  r = build(dir, {}, ['--unreviewed-build']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules/native/build/Release/out.txt')), true);
});

test('no inherited environment can permit an unreviewed build', (t) => {
  const { dir } = installed(t);
  fs.rmSync(path.join(dir, 'install-scripts.json'));
  // The permission travels on the call. A variable the process happened to
  // inherit — a caller's shell, a CI job that set it for its install step —
  // says nothing about this build.
  const r = build(dir, { INSTALL_SCRIPTS_UNREVIEWED: 'build' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not reviewed/);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules/native/build')), false);
});

test('an unsupported argument is a usage error', (t) => {
  const { dir } = installed(t);
  const r = build(dir, {}, ['--rebuild-everything']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unsupported argument/);
});

test('a failing install script fails the build and changes nothing', (t) => {
  const { dir } = installed(t);
  put(dir, 'node_modules/native/build.js', 'process.exit(3);\n');
  const r = build(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm rebuild failed/);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules/native/gyp-version.txt')), false);
});

test('without an absolute npm-cli.js the builder refuses to start', (t) => {
  const { dir } = installed(t);
  for (const value of ['', 'npm', path.join(dir, 'missing.js')]) {
    assert.equal(build(dir, { NPM_CLI: value }).status, 2, value);
  }
});

test('a staging directory under a node_modules parent is refused', (t) => {
  const { dir, marker } = installed(t);
  // TMPDIR inside the install: the stage's parents include the project, whose
  // node_modules/.bin npm would search.
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  const r = build(dir, { TMPDIR: tmp });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holds a node_modules; set TMPDIR to a directory outside any project/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules/native/gyp-version.txt')), false);
});

const smoke = (dir, env = {}) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'smoke-allowed-packages.js')], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, ...env },
});

test('an allowed package the lockfile says was omitted is skipped', (t) => {
  const { dir } = installed(t);
  const lockFile = path.join(dir, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.packages['node_modules/native'].dev = true;
  lock.packages['node_modules/helper'].dev = true;
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  assert.deepEqual(write(dir).problems, []);
  fs.rmSync(path.join(dir, 'node_modules', 'native'), { recursive: true });
  assert.equal(build(dir, { INSTALL_OMIT: 'dev' }).status, 0);
  assert.equal(smoke(dir, { INSTALL_OMIT: 'dev' }).status, 0);
  // The same absence without that omit is an error.
  const r = build(dir, { INSTALL_OMIT: 'optional' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /native should be installed and is not/);
});

test('an allowed package that should be installed and is missing fails the build and the smoke test', (t) => {
  const { dir } = installed(t);
  fs.rmSync(path.join(dir, 'node_modules', 'native'), { recursive: true });
  for (const omit of ['', 'dev', 'dev,optional,peer']) {
    const r = build(dir, { INSTALL_OMIT: omit });
    assert.equal(r.status, 1, omit);
    assert.match(r.stderr, /native should be installed and is not/, omit);
    assert.notEqual(smoke(dir, { INSTALL_OMIT: omit }).status, 0, omit);
  }
});

test('nothing allowed means nothing to build', (t) => {
  const dir = tempDir(t);
  put(dir, 'package.json', { name: 'plain' });
  put(dir, 'package-lock.json', { name: 'plain', lockfileVersion: 3, packages: { '': {} } });
  assert.equal(build(dir).status, 0);
});
