'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { check, checkDir, write, omittedByInstall, RECORD } = require('../tools/check-install-scripts.js');
const { tempDir } = require('./helpers.js');

const CHECKER = path.join(__dirname, '..', 'tools', 'check-install-scripts.js');
const REG = 'https://registry.npmjs.org';

function integrity(seed) {
  return `sha512-${Buffer.alloc(64, seed).toString('base64')}`;
}

function entry(name, version, extra = {}) {
  return {
    version,
    resolved: `${REG}/${name}/-/${name.split('/').pop()}-${version}.tgz`,
    integrity: integrity(`${name}@${version}`),
    ...extra,
  };
}

// A project allowing one native package whose closure is two more packages, one
// of them nested; plus unrelated packages, one with a denied install script.
function lockfile() {
  return {
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { native: '1.0.0', plain: '1.0.0', denied: '1.0.0' } },
      'node_modules/native': entry('native', '1.0.0', { hasInstallScript: true, dependencies: { addon: '^2', helper: '^1' } }),
      'node_modules/addon': entry('addon', '2.0.0', { dependencies: { helper: '^3' } }),
      'node_modules/addon/node_modules/helper': entry('helper', '3.0.0'),
      'node_modules/helper': entry('helper', '1.0.0'),
      'node_modules/plain': entry('plain', '1.0.0', { dependencies: { helper: '^1' } }),
      'node_modules/denied': entry('denied', '1.0.0', { hasInstallScript: true }),
    },
  };
}

/** @type {any} */
const PKG = { name: 'app', allowScripts: { native: true, denied: false } };

/**
 * @param {import('node:test').TestContext} t
 * @param {{ pkg?: any, lock?: any }} [options]
 */
function project(t, { pkg = PKG, lock = lockfile() } = {}) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  return dir;
}

function reviewed(t) {
  const dir = project(t);
  assert.deepEqual(write(dir).problems, []);
  return JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')).packages;
}

/** @type {(record: any, lock: any, pkg?: any) => string[]} */
const judge = (record, lock, pkg = PKG) => check({ pkg, lock, record }).problems;

test('the record pins the closure of each allowed package, and an unchanged lockfile passes', (t) => {
  const dir = project(t);
  assert.deepEqual(checkDir(dir).problems, [`native: allowed in allowScripts but not reviewed in ${RECORD}`]);
  assert.deepEqual(write(dir).problems, []);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
  assert.match(doc.toolchain, /node-gyp/);
  assert.deepEqual(Object.keys(doc.packages.native), [
    'node_modules/addon', 'node_modules/addon/node_modules/helper', 'node_modules/helper', 'node_modules/native',
  ]);
  assert.deepEqual(doc.packages.native['node_modules/addon'], {
    version: '2.0.0', resolved: `${REG}/addon/-/addon-2.0.0.tgz`, integrity: integrity('addon@2.0.0'),
  });
  assert.deepEqual(checkDir(dir).problems, []);
});

test('changes outside the closures do not matter', (t) => {
  const record = reviewed(t);
  const lock = lockfile();
  lock.packages['node_modules/plain'] = entry('plain', '9.9.9', { dependencies: { helper: '^1' } });
  lock.packages['node_modules/extra'] = entry('extra', '1.0.0');
  lock.packages['node_modules/denied'] = entry('denied', '2.0.0', { hasInstallScript: true });
  assert.deepEqual(judge(record, lock), []);
});

test('any change to a closure package is not reviewed, even with the same version', (t) => {
  const record = reviewed(t);
  /** @type {Array<[string, (l: any) => void, string[]]>} */
  const cases = [
    ['a version bump', (l) => { l.packages['node_modules/native'] = entry('native', '1.0.1', { hasInstallScript: true, dependencies: { addon: '^2', helper: '^1' } }); },
      ['native: review node_modules/native, 1.0.0 -> 1.0.1']],
    ['different bytes (an exports-only change republished)', (l) => { l.packages['node_modules/addon'].integrity = integrity('other'); },
      ['native: review node_modules/addon, 2.0.0 -> 2.0.0 (different bytes)']],
    ['another tarball URL', (l) => { l.packages['node_modules/addon/node_modules/helper'].resolved = `${REG}/helper/-/helper-3.0.0-b.tgz`; },
      ['native: review node_modules/addon/node_modules/helper, 3.0.0 -> 3.0.0 (different bytes)']],
    ['a new dependency', (l) => {
      l.packages['node_modules/addon'].dependencies.fresh = '^1';
      l.packages['node_modules/fresh'] = entry('fresh', '1.0.0');
    }, ['native: review node_modules/fresh@1.0.0, new in the closure']],
    ['a dependency hoisted elsewhere', (l) => {
      delete l.packages['node_modules/addon/node_modules/helper'];
    }, ['native: node_modules/addon/node_modules/helper left the reviewed closure']],
  ];
  for (const [label, change, expected] of cases) {
    const lock = lockfile();
    change(lock);
    assert.deepEqual(judge(record, lock), expected, label);
  }
});

test('what the lockfile cannot vouch for is not reviewed', (t) => {
  const record = reviewed(t);
  /** @type {Array<[string, (l: any) => void, RegExp]>} */
  const cases = [
    ['a git dependency', (l) => { l.packages['node_modules/addon'].resolved = 'git+ssh://git@example.com/addon.git#abc'; },
      /node_modules\/addon does not come from the npm registry/],
    ['another registry', (l) => { l.packages['node_modules/helper'].resolved = 'https://registry.example.com/helper-1.0.0.tgz'; },
      /node_modules\/helper does not come from the npm registry/],
    ['no integrity', (l) => { delete l.packages['node_modules/native'].integrity; }, /node_modules\/native has no sha512 integrity/],
    ['a sha1 integrity', (l) => { l.packages['node_modules/native'].integrity = 'sha1-abc='; }, /has no sha512 integrity/],
    ['a linked package', (l) => { l.packages['node_modules/addon'] = { resolved: 'addon', link: true }; }, /node_modules\/addon is a link/],
    ['a missing dependency', (l) => { delete l.packages['node_modules/helper']; },
      /node_modules\/native depends on helper, which the lockfile does not have/],
    ['a new package with an install script', (l) => { l.packages['node_modules/rogue'] = entry('rogue', '1.0.0', { hasInstallScript: true }); },
      /node_modules\/rogue has an install script that allowScripts does not name/],
    ['a nested copy with an install script', (l) => { l.packages['node_modules/plain/node_modules/rogue'] = entry('rogue', '1.0.0', { hasInstallScript: true }); },
      /node_modules\/plain\/node_modules\/rogue has an install script/],
    ['an old lockfile', (l) => { l.lockfileVersion = 1; }, /lockfile version 2 or later/],
  ];
  for (const [label, change, expected] of cases) {
    const lock = lockfile();
    change(lock);
    const problems = judge(record, lock);
    assert.ok(problems.some((p) => expected.test(p)), `${label}: ${JSON.stringify(problems)}`);
  }
  assert.ok(judge(record, { packages: null }).length > 0);
  assert.ok(judge(record, null).length > 0);
});

test('the allow list and the record must agree, and entries name packages only', (t) => {
  const record = reviewed(t);
  assert.deepEqual(judge(record, lockfile(), { allowScripts: { native: false, denied: false } }),
    ['native: reviewed in install-scripts.json but not allowed in allowScripts']);
  assert.deepEqual(judge(record, lockfile(), { allowScripts: { native: true, denied: false, gone: true } }),
    ['gone: allowed in allowScripts but not in package-lock.json']);
  assert.match(judge(record, lockfile(), { allowScripts: { 'native@1.0.0': true, native: true, denied: false } })[0],
    /"native@1\.0\.0" is not a bare package name/);
  assert.match(judge(record, lockfile(), { allowScripts: { native: true, denied: 'yes' } })[0], /neither true nor false/);
  assert.match(judge(record, lockfile(), { allowScripts: ['native'] })[0], /allowScripts is not an object/);
  // Without any allow list, a package with an install script is not reviewed.
  assert.deepEqual(judge({}, lockfile(), {}), [
    'node_modules/native has an install script that allowScripts does not name',
    'node_modules/denied has an install script that allowScripts does not name',
  ]);
  // Nothing recorded is written while anything is wrong.
  const dir = project(t, { pkg: { allowScripts: { 'native@1': true } } });
  assert.match(write(dir).problems[0], /not a bare package name/);
  assert.equal(fs.existsSync(path.join(dir, RECORD)), false);
});

test('the command line judges a directory, or three files given as data', (t) => {
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

  const files = (lock) => {
    const other = tempDir(t);
    fs.writeFileSync(path.join(other, 'lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock));
    return ['--package', path.join(dir, 'package.json'), '--lock', path.join(other, 'lock.json'), '--record', path.join(dir, RECORD)];
  };
  assert.equal(run(...files(lockfile())).status, 0);
  const changed = lockfile();
  changed.packages['node_modules/addon'].integrity = integrity('x');
  r = run(...files(changed));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /review node_modules\/addon/);
  r = run(...files('not json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the manifests/);
  r = run('--package', path.join(dir, 'package.json'), '--lock', path.join(dir, 'package-lock.json'), '--record', path.join(dir, 'none.json'));
  assert.equal(r.status, 1, 'no record means nothing is reviewed');

  for (const bad of [[], [path.join(dir, 'nowhere')], [dir, dir], ['--package', 'x'], ['--package', 'a', '--lock', 'b'],
    ['--package', 'a', '--lock', 'b', '--record', 'c', dir], ['--write', '--package', 'a', '--lock', 'b', '--record', 'c']]) {
    assert.equal(run(...bad).status, 2, JSON.stringify(bad));
  }
});

test('the core records the closures its own install scripts run', () => {
  const root = path.join(__dirname, '..');
  for (const dir of ['.', 'app', 'ha-tools']) {
    assert.deepEqual(checkDir(path.join(root, dir)).problems, [], dir);
  }
  const record = JSON.parse(fs.readFileSync(path.join(root, 'app', RECORD), 'utf8')).packages;
  assert.deepEqual(Object.keys(record), ['node-pty']);
  assert.ok('node_modules/node-addon-api' in record['node-pty']);
});

test('what an install with --omit leaves out follows the lockfile flags', () => {
  const lock = { packages: {
    'node_modules/d': { dev: true }, 'node_modules/o': { optional: true }, 'node_modules/p': { peer: true },
    'node_modules/do': { devOptional: true }, 'node_modules/prod': {},
  } };
  const out = (key, omit) => omittedByInstall(lock, key, omit);
  assert.equal(out('node_modules/d', 'dev'), true);
  assert.equal(out('node_modules/d', 'optional,peer'), false);
  assert.equal(out('node_modules/o', 'optional'), true);
  assert.equal(out('node_modules/p', 'peer'), true);
  assert.equal(out('node_modules/do', 'dev'), false);
  assert.equal(out('node_modules/do', 'dev,optional'), true);
  assert.equal(out('node_modules/prod', 'dev,optional,peer'), false);
  assert.equal(out('node_modules/missing', 'dev'), false);
  assert.equal(out('node_modules/d', undefined), false);
});
