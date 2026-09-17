'use strict';

// The install wrapper finds the image's node and npm before anything is
// installed, and refuses any that a package or the project itself provides.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { tempDir } = require('./helpers.js');

const WRAPPER = path.join(__dirname, '..', 'tools', 'npm-ci-checked.sh');

/** @param {import('node:test').TestContext} t */
function emptyProject(t) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'empty', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'empty', version: '1.0.0' } },
  }));
  return dir;
}

// A command named `name` in `binDir` that only leaves a marker behind.
function hijacker(binDir, name, marker) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\necho ${name} >> "${marker}"\nexit 0\n`, { mode: 0o755 });
}

const wrap = (dir, env = {}) => spawnSync('bash', [WRAPPER], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, NPM_CLI: '', ...env },
});

test('an empty project installs with the image tools', (t) => {
  const dir = emptyProject(t);
  const r = wrap(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /install scripts: as reviewed \(none allowed\)/);
});

test('a node or npm provided by a node_modules/.bin on PATH is refused before anything runs', (t) => {
  for (const name of ['node', 'npm']) {
    const dir = emptyProject(t);
    const marker = path.join(dir, 'hijacked');
    const bin = path.join(dir, 'node_modules', '.bin');
    hijacker(bin, name, marker);
    const r = wrap(dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`${name} resolves inside node_modules`), name);
    assert.equal(fs.existsSync(marker), false, `${name}: the hijacker did not run`);
    assert.equal(fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json')), false, `${name}: nothing was installed`);
  }
});

test('a node or npm from inside the project is refused, wherever it sits', (t) => {
  for (const name of ['node', 'npm']) {
    const dir = emptyProject(t);
    const marker = path.join(dir, 'hijacked');
    hijacker(path.join(dir, 'tools-of-its-own'), name, marker);
    const r = wrap(dir, { PATH: `${path.join(dir, 'tools-of-its-own')}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`${name} resolves inside `), name);
    assert.equal(fs.existsSync(marker), false, name);
  }
});

test('a preset npm must be an installed npm-cli.js outside the project and outside other packages', (t) => {
  const dir = emptyProject(t);
  /** @type {Array<[string, RegExp]>} */
  const cases = [
    [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), /npm is inside/],
    ['/opt/somewhere/npm.js', /not an installed npm-cli\.js/],
    ['relative/node_modules/npm/bin/npm-cli.js', /not an installed npm-cli\.js/],
    ['/opt/app/node_modules/pkg/node_modules/npm/bin/npm-cli.js', /inside another package/],
  ];
  for (const [value, message] of cases) {
    const r = wrap(dir, { NPM_CLI: value });
    assert.equal(r.status, 1, value);
    assert.match(r.stderr, message, value);
  }
});

test('only --omit=dev, --omit=optional and --omit=peer are accepted, and nothing runs otherwise', (t) => {
  const dir = emptyProject(t);
  for (const args of [['--ignore-scripts=false'], ['--omit', 'dev'], ['--omit=bundle'], ['--foreground-scripts'], ['--omit=dev', 'x']]) {
    const r = spawnSync('bash', [WRAPPER, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NPM_CLI: '' } });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /unsupported argument/, args.join(' '));
    assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false, args.join(' '));
  }
});

test('--omit=dev leaves the dev dependencies out', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'devtool'));
  fs.writeFileSync(path.join(dir, 'devtool', 'package.json'), JSON.stringify({ name: 'devtool', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'withdev', version: '1.0.0', devDependencies: { devtool: 'file:./devtool' },
  }));
  const npmCli = fs.realpathSync(spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim());
  const lock = spawnSync(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--offline'], { cwd: dir, encoding: 'utf8' });
  assert.equal(lock.status, 0, lock.stderr);
  let r = spawnSync('bash', [WRAPPER, '--omit=dev'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NPM_CLI: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'devtool')), false);
  r = spawnSync('bash', [WRAPPER], { cwd: dir, encoding: 'utf8', env: { ...process.env, NPM_CLI: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'devtool', 'package.json')), true);
});
