'use strict';

// The console's colours: an optional data file in the adapter slot, complete or
// refused, and a neutral palette of the core's own when the file is not there.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KEYS, NEUTRAL, validateTheme, readTheme, accentRgb } = require('../../server/theme');
const { NEUTRAL_BRANDING } = require('../fixtures/neutral-adapter');

const SERVER = path.join(__dirname, '..', '..', 'server');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-theme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const withColour = (section, key, value) => ({ ...NEUTRAL, [section]: { ...NEUTRAL[section], [key]: value } });

test('the neutral palette is complete, valid and frozen', () => {
  assert.deepEqual(Object.keys(KEYS), ['ui', 'terminal', 'search']);
  for (const [section, keys] of Object.entries(KEYS)) {
    assert.deepEqual(Object.keys(NEUTRAL[section]), [...keys], section);
    assert.ok(Object.isFrozen(NEUTRAL[section]), section);
  }
  assert.deepEqual(validateTheme(NEUTRAL), NEUTRAL);
  assert.ok(Object.isFrozen(NEUTRAL));
});

test('the neutral palette carries no engine\'s brand colour', () => {
  // The terracotta of one engine's product, in every form its pages use it.
  const brand = [/d97757/i, /217,\s*119,\s*87/, /f2b49f/i];
  for (const [section, colours] of Object.entries(NEUTRAL)) {
    for (const [key, colour] of Object.entries(colours)) {
      for (const re of brand) assert.doesNotMatch(colour, re, `${section}.${key}`);
    }
  }
  assert.doesNotMatch(accentRgb(NEUTRAL), brand[1]);
});

test('every section and key is required, and no other is accepted', () => {
  for (const [section, keys] of Object.entries(KEYS)) {
    const rest = { ...NEUTRAL };
    delete rest[section];
    assert.throws(() => validateTheme(rest), new RegExp(`${section} must be an object`));
    for (const key of keys) {
      const colours = { ...NEUTRAL[section] };
      delete colours[key];
      assert.throws(() => validateTheme({ ...NEUTRAL, [section]: colours }), new RegExp(`${section}\\.${key} must be a colour`));
    }
    assert.throws(() => validateTheme(withColour(section, 'glow', '#fff')), new RegExp(`${section}\\.glow is not a theme key`));
  }
  assert.throws(() => validateTheme({ ...NEUTRAL, fonts: {} }), /fonts is not a theme section/);
  for (const value of [null, [], '#fff', 7]) assert.throws(() => validateTheme(value), /not an object/);
});

test('a colour is one of a few plain forms, so it needs no escaping anywhere', () => {
  for (const good of ['#abc', '#AABBCC', '#aabbcc80', 'rgb(1, 2, 3)', 'rgba(255,255,255,0.07)', 'rgba(0, 0, 0, .5)', 'rgba(1, 2, 3, 1)']) {
    assert.equal(validateTheme(withColour('ui', 'border', good)).ui.border, good);
  }
  for (const bad of ['', 'red', '#abcd', '#12345g', 'rgba(1, 2, 3, 0.5', 'rgba(1,2,3,50%)', 'var(--x)',
    '#fff; background: url(x)', '#fff}', 'rgb(1, 2, 3)</style>', ' #fff', 7, null]) {
    assert.throws(() => validateTheme(withColour('ui', 'border', bad)), /ui\.border must be a colour/, JSON.stringify(bad));
  }
  assert.throws(() => validateTheme(withColour('ui', 'accent', '#abc')), /ui\.accent must be #rrggbb/);
  assert.equal(accentRgb(withColour('ui', 'accent', '#D97757')), '217, 119, 87');
});

test('no file means the neutral palette; a file is read whole, parsed and checked', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'theme.json');
  assert.equal(readTheme(file), NEUTRAL);
  const custom = withColour('terminal', 'cursor', '#ff8800');
  fs.writeFileSync(file, JSON.stringify(custom));
  const read = readTheme(file);
  assert.deepEqual(read, custom);
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.terminal));
  fs.writeFileSync(file, '{"ui":');
  assert.throws(() => readTheme(file), /is not JSON/);
  fs.writeFileSync(file, JSON.stringify({ ...custom, pad: 'x'.repeat(17000) }));
  assert.throws(() => readTheme(file), /larger than 16384 bytes/);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readTheme(file), /cannot be read/);
});

// The assembled tree: server/ next to adapter/index.js, branding.json and,
// when given, theme.json.
function loadAssembled(dir, themeText) {
  fs.cpSync(SERVER, path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'adapter'));
  const fixture = path.join(__dirname, '..', 'fixtures', 'neutral-adapter.js');
  fs.writeFileSync(path.join(dir, 'adapter', 'index.js'),
    `module.exports = require(${JSON.stringify(fixture)}).createNeutralAdapter().adapter;\n`);
  fs.writeFileSync(path.join(dir, 'adapter', 'branding.json'), JSON.stringify(NEUTRAL_BRANDING));
  if (themeText !== undefined) fs.writeFileSync(path.join(dir, 'adapter', 'theme.json'), themeText);
  const script = `const c = require(${JSON.stringify(path.join(dir, 'server', 'adapter-contract'))});
try { c.adapter(); process.stdout.write(JSON.stringify(c.theme())); }
catch (err) { process.stdout.write('refused: ' + err.message); }`;
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

test('the core loads the colours from the adapter slot together with the adapter', (t) => {
  const custom = withColour('search', 'matchBorder', '#123456');
  assert.deepEqual(JSON.parse(loadAssembled(tmpDir(t), JSON.stringify(custom))), custom);
  assert.deepEqual(JSON.parse(loadAssembled(tmpDir(t), undefined)), NEUTRAL);
});

test('an adapter slot with an invalid theme file does not load', (t) => {
  assert.match(loadAssembled(tmpDir(t), '[]'), /^refused: theme: not an object/);
  assert.match(loadAssembled(tmpDir(t), JSON.stringify(withColour('ui', 'fg', 'white'))), /^refused: theme: ui\.fg must be a colour/);
});
