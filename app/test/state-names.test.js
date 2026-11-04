'use strict';

// The states-list scan on its own: where a chunk ends must never matter, and what
// is not a list of objects must never read as one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStateNames } = require('../server/prompt/state-names');

const scan = (...chunks) => {
  const names = createStateNames();
  for (const chunk of chunks) names.push(Buffer.from(chunk));
  return names.end();
};

const TRICKY = [
  { entity_id: 'light.a', attributes: { friendly_name: 'Küche "Süd" ☀ \\ } ] {' }, state: 'on' },
  { entity_id: 'sensor.b', attributes: { nested: { list: [1, { deep: '}]' }] } }, state: '1' },
  { entity_id: 'switch.c', state: 'off' },
  { entity_id: 'light.d', attributes: { friendly_name: 7 } },
];
const KEPT = [
  { entity_id: 'light.a', attributes: { friendly_name: TRICKY[0].attributes.friendly_name } },
  { entity_id: 'sensor.b', attributes: {} },
  { entity_id: 'switch.c', attributes: {} },
  { entity_id: 'light.d', attributes: {} },
];

test('a list split at any byte reads the same', () => {
  const bytes = Buffer.from(JSON.stringify(TRICKY));
  for (let cut = 0; cut <= bytes.length; cut += 1) {
    assert.deepEqual(scan(bytes.subarray(0, cut), bytes.subarray(cut)), KEPT, `split at ${cut}`);
  }
});

test('a list delivered byte by byte reads the same', () => {
  const bytes = Buffer.from(JSON.stringify(TRICKY, null, 2));
  assert.deepEqual(scan(...[...bytes].map((b) => [b])), KEPT);
});

test('what is held falls back to what was kept once a state is read', () => {
  const names = createStateNames();
  names.push(Buffer.from('[{"entity_id":"light.a","pad":"xxxxxxxxxxxxxxxx'));
  assert.ok(names.held() > 40);
  names.push(Buffer.from('"}'));
  assert.equal(names.held(), 'light.a'.length);
});

test('spaces between states are not a grammar error', () => {
  assert.deepEqual(scan(' [ { } , \n { } ] '), [{ entity_id: undefined, attributes: {} }, { entity_id: undefined, attributes: {} }]);
});

test('an empty list is a list', () => {
  assert.deepEqual(scan(' [ ] \n'), []);
});

for (const [what, text] of [
  ['nothing', ''],
  ['an object', '{"entity_id":"light.a"}'],
  ['a list never closed', '[{"entity_id":"light.a"},'],
  ['a state never closed', '[{"entity_id":"light.a"'],
  ['a string never closed', '[{"entity_id":"light.a'],
  ['a list of strings', '["light.a"]'],
  ['a list of numbers', '[1,2]'],
  ['a list of lists', '[[{"entity_id":"light.a"}]]'],
  ['mismatched brackets', '[{"entity_id":"light.a"]]'],
  ['a state that is not JSON', '[{entity_id:1}]'],
  ['content after the list', '[{"entity_id":"light.a"}] x'],
  ['a second list', '[][]'],
  ['a comma alone', '[,]'],
  ['a comma first', '[,{}]'],
  ['a comma last', '[{},]'],
  ['two commas', '[{},,{}]'],
  ['no comma', '[{}{}]'],
  ['no comma across space', '[{} {}]'],
]) {
  test(`${what} is not a list of states`, () => {
    assert.equal(scan(text), null);
  });
}
