'use strict';

// A console page whose files did not arrive loads again, a bounded number of times.
// The script is taken from the page and run against a stand-in for the browser, with
// each way a file can fail delivered as the browser delivers it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const page = fs.readFileSync(path.join(TEMPLATES, 'index.html'), 'utf8');
const found = page.match(/<script id="load-retry">([\s\S]*?)<\/script>/);

const APPLIED = { cssRules: [{}] };

function browser({ storage = new Map(), blocked = false, sheets = [APPLIED], scriptRan = true } = {}) {
  const listeners = {};
  const timers = [];
  const reloads = [];
  const notes = [];
  const on = (name) => (type, fn) => { listeners[`${name}.${type}`] = fn; };
  const store = {
    getItem(k) { if (blocked) throw new Error('blocked'); return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { if (blocked) throw new Error('blocked'); storage.set(k, v); },
    removeItem(k) { if (blocked) throw new Error('blocked'); storage.delete(k); },
  };
  const window = { addEventListener: on('window'), consoleScriptRan: scriptRan };
  const document = {
    addEventListener: on('document'),
    querySelectorAll: () => sheets.map((sheet) => ({ sheet })),
    createElement: () => ({ style: {} }),
    body: { prepend: (note) => notes.push(note.textContent) },
  };
  assert.ok(found, 'index.html has no load-retry script');
  vm.runInNewContext(found[1], {
    window,
    document,
    sessionStorage: store,
    location: { reload: () => reloads.push(1) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
  });
  return { listeners, timers, reloads, notes, storage };
}
const failedFile = (b, target) => b.listeners['document.error']({ target });
const STYLESHEET = { tagName: 'LINK', rel: 'stylesheet' };
const SCRIPT = { tagName: 'SCRIPT' };

test('a script or a stylesheet that fails to load reloads the page, once for all of them', () => {
  for (const target of [STYLESHEET, SCRIPT]) {
    const b = browser();
    failedFile(b, target);
    failedFile(b, SCRIPT);
    b.listeners['window.load']();
    assert.equal(b.timers.length, 1);
    b.timers[0].fn();
    assert.equal(b.reloads.length, 1);
  }
});

test('a font or an icon that fails does not', () => {
  const b = browser();
  failedFile(b, { tagName: 'LINK', rel: 'preload' });
  failedFile(b, { tagName: 'LINK', rel: 'icon' });
  failedFile(b, { tagName: 'IMG' });
  assert.equal(b.timers.length, 0);
});

test('a success that is not the file reloads too: no script ran, or a stylesheet with no rules', () => {
  for (const shape of [{ scriptRan: false }, { sheets: [APPLIED, null] }, { sheets: [APPLIED, { cssRules: [] }] }]) {
    const b = browser(shape);
    b.listeners['window.load']();
    assert.equal(b.timers.length, 1, JSON.stringify(shape));
  }
});

test('it backs off and stops, and then says so', () => {
  const storage = new Map();
  const waits = [];
  for (let i = 0; i < 5; i += 1) {
    const b = browser({ storage });
    failedFile(b, SCRIPT);
    assert.equal(b.notes.length, 0);
    waits.push(b.timers[0].ms);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  const last = browser({ storage });
  failedFile(last, SCRIPT);
  assert.equal(last.timers.length, 0);
  assert.match(last.notes[0], /could not load/);
});

test('a page that loaded starts the count again', () => {
  const storage = new Map([['console-load-retries', '3']]);
  const b = browser({ storage });
  b.listeners['window.load']();
  assert.equal(b.timers.length, 0);
  assert.equal(storage.size, 0);
});

test('without storage to count in it does not reload at all', () => {
  const b = browser({ blocked: true });
  failedFile(b, SCRIPT);
  assert.equal(b.timers.length, 0);
  assert.match(b.notes[0], /could not load/);
});

test('it runs before the first stylesheet, and the console script reports that it ran', () => {
  assert.ok(page.indexOf('id="load-retry"') < page.indexOf('rel="stylesheet"'));
  const script = fs.readFileSync(path.join(TEMPLATES, 'app.js'), 'utf8');
  assert.match(script.trimEnd().split('\n').slice(-3).join('\n'), /window\.consoleScriptRan = true;/);
});
