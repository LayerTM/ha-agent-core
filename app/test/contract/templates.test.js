'use strict';

// The console pages the core ships: they render for any engine, name none, use
// every name and colour the contract offers, and link only files the console
// serves.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PAGES, pageValues, renderPage } = require('../../server/pages');
const { ICONS, PACKAGE_FILES } = require('../../server/console-assets');
const { NEUTRAL, KEYS: THEME_KEYS } = require('../../server/theme');
const { KEYS: BRANDING_KEYS } = require('../../server/branding');
const { NEUTRAL_BRANDING } = require('../fixtures/neutral-adapter');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const CONSOLE = { windowName: 'agent', updateCommand: '/usr/local/bin/update-agent' };
const read = (name) => fs.readFileSync(path.join(TEMPLATES, name), 'utf8');

// Names that stay because clients depend on them: the restart route, the
// status field and the function that calls that route.
const FROZEN = [/api\('claude\/respawn'\)/g, /\bclaudeVersion\b/g, /\brespawnClaude\b/g];
const BRAND = /claude|anthropic|openai|codex|terracotta/i;

test('the core ships exactly the console pages', () => {
  assert.deepEqual(fs.readdirSync(TEMPLATES).sort(), Object.keys(PAGES).sort());
});

test('every page renders for a neutral engine and names no engine or palette', () => {
  const values = pageValues({ branding: NEUTRAL_BRANDING, theme: NEUTRAL, console: CONSOLE });
  for (const name of Object.keys(PAGES)) {
    const out = renderPage(read(name), name, values);
    assert.ok(!out.includes('{{'), name);
    const unfrozen = FROZEN.reduce((text, re) => text.replace(re, ''), out);
    assert.doesNotMatch(unfrozen, BRAND, name);
    if (name !== 'styles.css' && name !== 'app.js') assert.ok(out.includes(NEUTRAL_BRANDING.productName), name);
  }
});

test('the startup page renders without the console values, as the placeholder renders it', () => {
  const values = pageValues({ branding: NEUTRAL_BRANDING, theme: NEUTRAL });
  assert.match(renderPage(read('starting.html'), 'starting.html', values), /<title>Neutral Agent/);
});

test('the pages use every name and every colour the contract offers', () => {
  const all = Object.keys(PAGES).map(read).join('\n');
  for (const key of Object.keys(BRANDING_KEYS)) {
    if (key === 'consoleName') continue; // the console's log line, not a page
    assert.ok(all.includes(`{{${key}}}`), key);
  }
  for (const [section, keys] of Object.entries(THEME_KEYS)) {
    for (const key of keys) assert.ok(all.includes(`{{theme.${section}.${key}}}`), `theme.${section}.${key}`);
  }
  for (const key of ['console.windowName', 'console.updateCommandName', 'theme.ui.accentRgb']) {
    assert.ok(all.includes(`{{${key}}}`), key);
  }
});

test('every vendor, font and icon file a page links is one the console serves', () => {
  const served = new Set([...Object.keys(PACKAGE_FILES), ...ICONS.map((n) => `/icons/${n}`)]);
  const linked = new Set();
  for (const name of Object.keys(PAGES)) {
    for (const [, ref] of read(name).matchAll(/["'(]((?:vendor|fonts|icons)\/[\w.-]+)["')?]/g)) linked.add(`/${ref}`);
  }
  assert.ok(linked.size >= 10, [...linked].join(' '));
  for (const ref of linked) assert.ok(served.has(ref), `${ref} is linked but not served`);
});
