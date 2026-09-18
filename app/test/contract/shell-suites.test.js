'use strict';

// The core's shell suites report success only when they actually checked
// something: exit 0 alone is not enough — a crashed helper inside `$( )` or a
// skipped suite also exits 0. A suite passes here only with exit 0, its own
// success line, no SKIP and nothing on stderr.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = path.join(__dirname, '..', '..');
const ROOT = path.join(APP, '..');

const SUITES = [
  { file: 'background-loop.test.sh', success: /^PASS: all background-loop checks passed$/m },
  { file: 'cc-alerts.test.sh', success: /^PASS: all cc-alerts checks passed$/m },
  { file: 'ha-token-check.test.sh', success: /^PASS: all ha-token-check checks passed$/m },
  { file: 'ha-curl.test.sh', success: /^PASS: all ha-curl checks passed$/m },
  { file: 'ha-core-ready.test.sh', success: /^PASS: all ha-core-ready checks passed$/m },
  { file: 'config-list.test.sh', success: /^All config_list tests passed\.$/m },
];

function runSuite(dir, file) {
  return spawnSync('bash', [path.join(dir, 'app', 'test', file)], { encoding: 'utf8', timeout: 120000 });
}

// A copy of the tree a suite reads (app/test + rootfs), to break things in.
function copyTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-shell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(APP, 'test'), path.join(dir, 'app', 'test'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'rootfs'), path.join(dir, 'rootfs'), { recursive: true });
  return dir;
}

function assertGenuinePass(result, suite) {
  assert.equal(result.status, 0, `${suite.file} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '', `${suite.file} wrote to stderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /\bSKIP\b/, `${suite.file} skipped`);
  assert.match(result.stdout, suite.success);
}

for (const suite of SUITES) {
  test(`${suite.file} passes for real`, () => {
    assertGenuinePass(runSuite(ROOT, suite.file), suite);
  });
}

test('the suites read nothing outside the core tree', () => {
  for (const { file } of SUITES) {
    const text = fs.readFileSync(path.join(APP, 'test', file), 'utf8');
    for (const name of ['config.yaml', 'build.yaml', 'Dockerfile', 'DOCS.md', 'translations']) {
      assert.ok(!text.includes(name), `${file} refers to ${name}, which only an add-on has`);
    }
  }
});

test('a broken config reader fails the config suite', (t) => {
  const dir = copyTree(t);
  const lib = path.join(dir, 'rootfs', 'usr', 'local', 'lib', 'addon-config.sh');
  fs.appendFileSync(lib, '\nconfig_list() { printf "%s" "$(jq -r ".[$1][]?" "$2" 2>/dev/null)"; }\n');
  const result = runSuite(dir, 'config-list.test.sh');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /NOT ok/);
});

test('a missing script fails the alerts suite', (t) => {
  const dir = copyTree(t);
  fs.rmSync(path.join(dir, 'rootfs', 'usr', 'local', 'bin', 'cc-alerts'));
  const result = runSuite(dir, 'cc-alerts.test.sh');
  assert.notEqual(result.status, 0);
});

test('a suite that crashes behind a zero exit is not taken for a pass', () => {
  const crashed = { status: 0, stdout: 'All config_list tests passed.\n', stderr: 'Traceback (most recent call last):\n' };
  assert.throws(() => assertGenuinePass(crashed, SUITES[1]), /wrote to stderr/);
  const skipped = { status: 0, stdout: 'SKIP: jq not installed\n', stderr: '' };
  assert.throws(() => assertGenuinePass(skipped, SUITES[1]), /skipped/);
});
