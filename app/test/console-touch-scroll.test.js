'use strict';

// A one-finger vertical swipe scrolls the terminal history on a touch screen, the
// way the wheel does on a desktop; every other touch stays the browser's. The
// function is taken from the console's own script and driven with stand-in touch
// events: the console has no module system to import it through.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'templates', 'app.js'), 'utf8');
const found = source.match(/^ {2}function bindTouchScroll\([\s\S]*?^ {2}\}$/m);

const ROW = 20; // px per terminal row; a notch is 3 rows = 60 px of finger travel

function surface() {
  assert.ok(found, 'app.js has no bindTouchScroll');
  const listeners = {};
  const el = {
    addEventListener(type, fn, opts) { (listeners[type] ||= []).push({ fn, opts }); },
  };
  const notches = [];
  const context = { el, notches, ROW };
  vm.runInNewContext(`${found[0]}
    result = bindTouchScroll(el, { rowHeight: () => ROW, notch: (d, x, y) => notches.push({ d, x, y }) });`,
  context);
  let prevented = 0;
  const fire = (type, points, t) => {
    const e = {
      type, timeStamp: t, cancelable: true,
      touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
      preventDefault() { prevented += 1; },
    };
    for (const { fn } of listeners[type] || []) fn(e);
  };
  return {
    listeners, notches, fire, scroller: context.result,
    get prevented() { return prevented; },
    // One finger from (x, y0) to (x, y1) in 10 px steps, starting to move at `delay` ms.
    drag(x, y0, y1, { delay = 0, dx = 0 } = {}) {
      fire('touchstart', [[x, y0]], 0);
      const n = Math.ceil(Math.abs(y1 - y0) / 10) || 1;
      for (let i = 1; i <= n; i += 1) {
        fire('touchmove', [[x + (dx * i) / n, y0 + ((y1 - y0) * i) / n]], delay + i * 16);
      }
      fire('touchend', [], delay + n * 16 + 16);
    },
  };
}

test('a finger moving down brings older lines in: one wheel-up notch per three rows', () => {
  const s = surface();
  s.drag(100, 100, 100 + 3 * 60 + 30);
  assert.deepEqual(s.notches.map((n) => n.d), [-1, -1, -1]);
  assert.ok(s.prevented > 0, 'the page itself must not scroll or bounce under the swipe');
  assert.equal(s.scroller.swiped(), true);
});

test('a finger moving up goes back towards the live screen', () => {
  const s = surface();
  s.drag(100, 400, 400 - 2 * 60);
  assert.deepEqual(s.notches.map((n) => n.d), [1, 1]);
});

test('each notch is reported where the finger first touched, so it lands on the terminal', () => {
  const s = surface();
  s.drag(37, 210, 400);
  assert.ok(s.notches.length > 0);
  for (const n of s.notches) assert.deepEqual([n.x, n.y], [37, 210]);
});

test('a tap is left alone: it still focuses the terminal and opens the keyboard', () => {
  const s = surface();
  s.fire('touchstart', [[100, 100]], 0);
  s.fire('touchend', [], 80);
  assert.equal(s.notches.length, 0);
  assert.equal(s.prevented, 0);
  assert.equal(s.scroller.swiped(), false);
});

test('a jitter smaller than the slop is still a tap', () => {
  const s = surface();
  s.drag(100, 100, 106);
  assert.equal(s.notches.length, 0);
  assert.equal(s.prevented, 0);
});

test('a drag that starts after a long press is a selection, not a scroll', () => {
  const s = surface();
  s.drag(100, 100, 400, { delay: 600 });
  assert.equal(s.notches.length, 0);
  assert.equal(s.prevented, 0);
  assert.equal(s.scroller.swiped(), false);
});

test('a sideways drag is not taken', () => {
  const s = surface();
  s.fire('touchstart', [[100, 100]], 0);
  s.fire('touchmove', [[140, 110]], 16);
  s.fire('touchmove', [[200, 300]], 32); // turning vertical later does not claim it
  s.fire('touchend', [], 48);
  assert.equal(s.notches.length, 0);
  assert.equal(s.prevented, 0);
});

test('a two-finger pinch is not taken', () => {
  const s = surface();
  s.fire('touchstart', [[100, 100], [200, 300]], 0);
  s.fire('touchmove', [[100, 50], [200, 400]], 16);
  s.fire('touchmove', [[100, 0], [200, 500]], 32);
  s.fire('touchend', [], 48);
  assert.equal(s.notches.length, 0);
  assert.equal(s.prevented, 0);
});

test('a second finger landing mid-swipe hands the gesture back to the browser', () => {
  const s = surface();
  s.fire('touchstart', [[100, 100]], 0);
  s.fire('touchmove', [[100, 170]], 16);
  const before = s.notches.length;
  assert.equal(before, 1);
  s.fire('touchmove', [[100, 300], [200, 300]], 32);
  s.fire('touchmove', [[100, 500], [200, 500]], 48);
  assert.equal(s.notches.length, before);
});

test('the next tap after a swipe is a tap again', () => {
  const s = surface();
  s.drag(100, 100, 300);
  assert.equal(s.scroller.swiped(), true);
  s.fire('touchstart', [[100, 100]], 1000);
  s.fire('touchend', [], 1080);
  assert.equal(s.scroller.swiped(), false);
});

test('touchstart can never block a tap: it is registered passive', () => {
  const s = surface();
  assert.ok(s.listeners.touchstart.every(({ opts }) => opts && opts.passive === true));
  assert.ok(s.listeners.touchmove.every(({ opts }) => opts && opts.passive === false),
    'a passive touchmove could not stop the page from scrolling under the swipe');
});

test('the end of a swipe does not copy an older selection again', () => {
  const body = source.match(/const maybeCopySelection = \(e\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(body, 'app.js has no maybeCopySelection');
  assert.match(body[0], /touchScroll\.swiped\(\)/);
});

test('the notch is a wheel event on the terminal screen, the path the desktop wheel takes', () => {
  const wiring = source.match(/const touchScroll = bindTouchScroll\(els\.terminal, \{[\s\S]*?\n {2}\}\);/);
  assert.ok(wiring, 'app.js does not wire bindTouchScroll to the terminal');
  assert.match(wiring[0], /dispatchEvent\(new WheelEvent\('wheel'/);
  assert.match(wiring[0], /\.xterm-screen/);
});
