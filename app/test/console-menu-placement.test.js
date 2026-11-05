'use strict';

// A menu stays on the screen, whichever button or point it opens at. The function
// is taken from the console's own script and run against a stand-in for the page:
// the console has no module system to import it through.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const source = fs.readFileSync(path.join(TEMPLATES, 'app.js'), 'utf8');
const found = source.match(/^ {2}function placeMenu\([\s\S]*?^ {2}\}$/m);

function placed({ width, height = 200, left, top = 40, screen, screenHeight = 800 }) {
  assert.ok(found, 'app.js has no placeMenu');
  const menu = { offsetWidth: width, offsetHeight: height, style: {} };
  const context = { window: { innerWidth: screen, innerHeight: screenHeight }, menu, left, top };
  vm.runInNewContext(`${found[0]}\nplaceMenu(menu, left, top);`, context);
  return { left: parseInt(menu.style.left, 10), top: parseInt(menu.style.top, 10), right: menu.style.right };
}

for (const screen of [320, 375, 500, 768]) {
  test(`a menu wider than the room left of its button stays on a ${screen} px screen`, () => {
    const at = placed({ width: 300, left: 268 - 320, screen });
    assert.ok(at.left >= 0, `left ${at.left}`);
    assert.ok(at.left + 300 <= screen, `right edge ${at.left + 300}`);
    assert.equal(at.right, 'auto', 'a right left from an earlier opening would stretch it');
  });
}

test('a menu with room opens where it was asked to', () => {
  assert.equal(placed({ width: 210, left: 500, screen: 1280 }).left, 500);
});

test('a menu near the far edge moves back onto the screen', () => {
  assert.equal(placed({ width: 210, left: 1200, screen: 1280 }).left, 1280 - 210 - 4);
});

test('a menu is never wider than a phone', () => {
  const css = fs.readFileSync(path.join(TEMPLATES, 'styles.css'), 'utf8');
  const rule = css.match(/^\.menu \{[^}]*\}/m);
  assert.ok(rule, 'styles.css has no .menu rule');
  assert.match(rule[0], /max-width: min\(320px, calc\(100vw - 8px\)\)/);
});
