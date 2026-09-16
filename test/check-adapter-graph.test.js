'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { check } = require('../tools/check-adapter-graph.js');
const { tempDir } = require('./helpers.js');

const CHECKER = path.join(__dirname, '..', 'tools', 'check-adapter-graph.js');
const APP = path.join(__dirname, '..', 'app');

// The core's own server tree with the neutral test adapter in the adapter slot —
// the same shape an add-on assembles.
function assembled(t) {
  const tree = tempDir(t);
  fs.cpSync(path.join(APP, 'server'), path.join(tree, 'server'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'adapter'));
  fs.copyFileSync(path.join(APP, 'test', 'fixtures', 'neutral-adapter.js'), path.join(tree, 'adapter', 'index.js'));
  return tree;
}

function write(tree, rel, text) {
  fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
  fs.writeFileSync(path.join(tree, rel), text);
}

test('the core tree with an adapter in its slot is clean', (t) => {
  const tree = assembled(t);
  const result = check(tree);
  assert.deepEqual(result.problems, []);
  assert.ok(result.files >= 14, `only ${result.files} modules seen`);
  const cli = spawnSync(process.execPath, [CHECKER, tree], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^adapter graph: clean \(\d+ modules\)\n$/);
});

test('without an adapter the loader does not resolve', (t) => {
  const tree = assembled(t);
  fs.rmSync(path.join(tree, 'adapter'), { recursive: true });
  assert.deepEqual(check(tree).problems, ["server/adapter-contract.js: require('../adapter') does not resolve to a file"]);
});

test('each forbidden edge is reported', (t) => {
  /** @type {Array<[string, string, RegExp]>} */
  const cases = [
    ['adapter/index.js', "require('../server/tmux');\n", /adapter\/index\.js: an adapter module requires core module server\/tmux\.js/],
    ['adapter/index.js', "require('../server/prompt/server');\n", /requires core module server\/prompt\/server\.js/],
    ['server/api.js', "require('../adapter');\n", /server\/api\.js: requires the adapter directly/],
    ['server/prompt/security.js', "require('./history');\n", /a leaf module requires server\/prompt\/history\.js/],
    ['server/adapter-contract.js', "require('./tmux');\n", /the adapter loader requires server\/tmux\.js/],
    ['server/shell.js', 'const name = "./tmux"; require(name);\n', /require\(name\) is not a string literal/],
    ['server/shell.js', "require('./missing');\n", /does not resolve to a file/],
  ];
  for (const [rel, line, pattern] of cases) {
    const tree = assembled(t);
    fs.appendFileSync(path.join(tree, rel), line);
    const { problems } = check(tree);
    assert.ok(problems.some((p) => pattern.test(p)), `${rel} + ${line.trim()}: ${problems}`);
  }
});

test('an adapter may use its own modules and the core leaves', (t) => {
  const tree = assembled(t);
  write(tree, 'adapter/runner.js', "const { validateProposal } = require('../server/prompt/security');\nmodule.exports = { validateProposal };\n");
  fs.appendFileSync(path.join(tree, 'adapter', 'index.js'), "require('./runner');\n");
  assert.deepEqual(check(tree).problems, []);
});

test('a cycle is reported', (t) => {
  const tree = assembled(t);
  write(tree, 'server/a.js', "require('./b');\n");
  write(tree, 'server/b.js', "require('./a');\n");
  const { problems } = check(tree);
  assert.ok(problems.some((p) => /^cycle: server\/(a|b)\.js -> server\/(a|b)\.js -> /.test(p)), String(problems));
});

test('a symlinked module is reported, and prose about require() is not a call', (t) => {
  const tree = assembled(t);
  fs.symlinkSync(path.join(tree, 'server', 'shell.js'), path.join(tree, 'server', 'linked.js'));
  write(tree, 'server/notes.js', "// see require(someName) in the docs\n/* require(other) */\nmodule.exports = 'http://example.invalid/x';\n");
  assert.deepEqual(check(tree).problems, ['server/linked.js: symlink in the module tree']);
});

test('usage errors exit 2', (t) => {
  assert.equal(spawnSync(process.execPath, [CHECKER], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CHECKER, tempDir(t)], { encoding: 'utf8' }).status, 2);
});
