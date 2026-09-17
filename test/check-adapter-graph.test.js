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
    ['server/branding.js', "require('./sources');\n", /a leaf module requires server\/sources\.js/],
    ['server/theme.js', "require('./pages');\n", /a leaf module requires server\/pages\.js/],
    ['server/shell.js', 'const name = "./tmux"; require(name);\n', /unsupported loading form: require\(\) with an argument that is not a string literal/],
    ['server/shell.js', "require('./missing');\n", /does not resolve to a file/],
  ];
  for (const [rel, line, pattern] of cases) {
    const tree = assembled(t);
    fs.appendFileSync(path.join(tree, rel), line);
    const { problems } = check(tree);
    assert.ok(problems.some((p) => pattern.test(p)), `${rel} + ${line.trim()}: ${problems}`);
  }
});

test('a forbidden edge cannot be hidden behind another loading form or file name', (t) => {
  // Each case was a way past the checker: an alias of require, a helper whose
  // name the scan did not read, and the other ways Node can load or run code.
  /** @type {Array<[string, string, RegExp, Record<string, string>?]>} */
  const cases = [
    ['adapter/index.js', "const load = require; load('../server/tmux');\n", /adapter\/index\.js: unsupported loading form: require used as a value/],
    ['adapter/index.js', "require('./helper.cjs');\n", /adapter\/helper\.cjs: an adapter module requires core module server\/tmux\.js/,
      { 'adapter/helper.cjs': "module.exports = require('../server/tmux');\n" }],
    ['adapter/index.js', "require('./helper');\n", /adapter\/helper\.cjs: an adapter module requires core module server\/tmux\.js/,
      { 'adapter/helper.cjs': "module.exports = require('../server/tmux');\n" }],
    ['adapter/index.js', "const r = require('./data.txt');\n", /loads adapter\/data\.txt, which is not \.js, \.cjs or \.json/,
      { 'adapter/data.txt': "require('../server/tmux')\n" }],
    ['adapter/index.js', "module.require('../server/tmux');\n", /unsupported loading form: module\.require/],
    ['adapter/index.js', "import('../server/tmux.js');\n", /unsupported loading form: import\(\)/],
    ['adapter/index.js', "const { createRequire } = require('node:module');\n", /unsupported loading form: createRequire/],
    ['adapter/index.js', "require('node:vm').runInThisContext('1');\n", /unsupported loading form: require\('node:vm'\)/],
    ['adapter/index.js', "eval(\"require('../server/tmux')\");\n", /unsupported loading form: eval/],
    ['adapter/index.js', "new Function('return 1')();\n", /unsupported loading form: Function/],
    ['adapter/index.js', "process.dlopen(module, 'x.node');\n", /unsupported loading form: dlopen/],
    ['adapter/index.js', "const t = `${require(`../server/${'tmux'}`)}`;\n", /require\(\) with an argument that is not a string literal/],
    ['adapter/index.js', "require('../public/outside.js');\n", /leaves server\/ and adapter\//, { 'public/outside.js': "require('./server/tmux');\n" }],
    ['adapter/index.js', "require('/etc/passwd');\n", /is an absolute path/],
    ['adapter/index.js', "const s = 'unterminated;\n", /cannot be scanned \(unterminated string\)/],
    ['adapter/index.js', '', /adapter\/native\.node: \.node modules are not supported/, { 'adapter/native.node': 'binary' }],
    ['adapter/index.js', '', /adapter\/esm\.mjs: \.mjs modules are not supported/, { 'adapter/esm.mjs': 'export default 1;\n' }],
  ];
  for (const [rel, line, pattern, extra = {}] of cases) {
    const tree = assembled(t);
    for (const [file, text] of Object.entries(extra)) write(tree, file, text);
    fs.appendFileSync(path.join(tree, rel), line);
    const { problems } = check(tree);
    assert.ok(problems.some((p) => pattern.test(p)), `${line.trim() || Object.keys(extra)}: ${problems}`);
  }
});

test('comments, strings and regular expressions that mention loading are not loading', (t) => {
  const tree = assembled(t);
  write(tree, 'adapter/prose.js', [
    '// const load = require; load(x); import("y"); eval(z)',
    "/* require(name) module.require('a') new Function() */",
    "const a = 'require(name) import(x) eval(y)';",
    'const b = "createRequire _load dlopen";',
    'const c = /require\\(name\\)/.test(a) ? 4 / 2 / 1 : 0;',
    'const d = `template with require(name) and ${a.length} and ${`nested ${b}`}`;',
    "module.exports = { a, b, c, d, e: require.resolve('node:fs') };",
    '',
  ].join('\n'));
  fs.appendFileSync(path.join(tree, 'adapter', 'index.js'), "require('./prose');\n");
  assert.deepEqual(check(tree).problems, []);
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
  write(tree, 'server/readme.txt', 'require(anything) is only text here\n');
  assert.deepEqual(check(tree).problems, ['server/linked.js: symlink in the module tree']);
});

test('usage errors exit 2', (t) => {
  assert.equal(spawnSync(process.execPath, [CHECKER], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CHECKER, tempDir(t)], { encoding: 'utf8' }).status, 2);
});
