'use strict';

// The engine's names: one data file in the adapter slot, checked with the
// adapter, with a closed key set and values that need no escaping anywhere.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KEYS, validateBranding, readBranding } = require('../../server/branding');
const { NEUTRAL_BRANDING } = require('../fixtures/neutral-adapter');

const SERVER = path.join(__dirname, '..', '..', 'server');
const CLAUDE = {
  productName: 'Claude Code', consoleName: 'Claude Console', agentName: 'Claude', cliName: 'Claude CLI', tabGlyph: '✳',
};

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-branding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the key set is closed and every key is required', () => {
  assert.deepEqual(Object.keys(KEYS), ['productName', 'consoleName', 'agentName', 'cliName', 'tabGlyph']);
  assert.deepEqual(validateBranding(NEUTRAL_BRANDING), NEUTRAL_BRANDING);
  assert.deepEqual(validateBranding(CLAUDE), CLAUDE);
  for (const key of Object.keys(KEYS)) {
    const rest = { ...CLAUDE };
    delete rest[key];
    assert.throws(() => validateBranding(rest), new RegExp(key));
  }
  assert.throws(() => validateBranding({ ...CLAUDE, theme: 'dark' }), /theme is not a branding key/);
  for (const value of [null, [], 'Claude', 7]) {
    assert.throws(() => validateBranding(value), /not an object/);
  }
});

test('a name needs no escaping in a page, a log line or a shell string', () => {
  const bad = ['', ' Claude', 'Claude ', 'x'.repeat(65), 'a<b', 'a>b', 'a&b', 'a"b', "a'b", 'a\\b', 'a`b',
    `a${String.fromCharCode(10)}b`, `a${String.fromCharCode(0)}b`, `a${String.fromCharCode(127)}b`, 7, null];
  for (const name of bad) {
    assert.throws(() => validateBranding({ ...CLAUDE, agentName: name }), /agentName must be/, JSON.stringify(name));
  }
  assert.equal(validateBranding({ ...CLAUDE, agentName: 'Агент 2 (β)' }).agentName, 'Агент 2 (β)');
});

test('the file is read whole, parsed and checked; the value is frozen', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'branding.json');
  fs.writeFileSync(file, JSON.stringify(CLAUDE));
  const names = readBranding(file);
  assert.deepEqual(names, CLAUDE);
  assert.ok(Object.isFrozen(names));
  assert.throws(() => readBranding(path.join(dir, 'missing.json')), /cannot be read/);
  fs.writeFileSync(file, '{"productName":');
  assert.throws(() => readBranding(file), /is not JSON/);
  fs.writeFileSync(file, JSON.stringify({ ...CLAUDE, agentName: 'x'.repeat(5000) }));
  assert.throws(() => readBranding(file), /larger than 4096 bytes/);
});

// The assembled tree: server/ next to adapter/index.js and adapter/branding.json.
function loadAssembled(dir, branding) {
  fs.cpSync(SERVER, path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'adapter'));
  const fixture = path.join(__dirname, '..', 'fixtures', 'neutral-adapter.js');
  fs.writeFileSync(path.join(dir, 'adapter', 'index.js'),
    `module.exports = require(${JSON.stringify(fixture)}).createNeutralAdapter().adapter;\n`);
  if (branding !== undefined) fs.writeFileSync(path.join(dir, 'adapter', 'branding.json'), branding);
  const script = `const c = require(${JSON.stringify(path.join(dir, 'server', 'adapter-contract'))});
try { c.adapter(); process.stdout.write(JSON.stringify(c.branding())); }
catch (err) { process.stdout.write('refused: ' + err.message); }`;
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

test('the core loads the names from the adapter slot together with the adapter', (t) => {
  assert.deepEqual(JSON.parse(loadAssembled(tmpDir(t), JSON.stringify(CLAUDE))), CLAUDE);
});

test('an adapter slot without valid names does not load', (t) => {
  assert.match(loadAssembled(tmpDir(t), undefined), /^refused: branding: .*branding\.json cannot be read/);
  assert.match(loadAssembled(tmpDir(t), '[]'), /^refused: branding: not an object/);
  assert.match(loadAssembled(tmpDir(t), JSON.stringify({ ...CLAUDE, consoleName: '' })), /^refused: branding: consoleName/);
});
