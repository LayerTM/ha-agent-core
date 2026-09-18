'use strict';

// One rule, one place: the leaf states how Home Assistant names a published
// tool, and the relay's gate must answer from that same rule for every shape a
// live server produces. Two adapters carried a copy of this rule until the leaf
// existed; these cases are what a copy would have to keep agreeing with.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { haBasename } = require('../server/prompt/ha-tool-names');
const { judgeClientBody } = require('../server/prompt/mcp-filter');

const call = (name) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
const allows = (name, basename) => judgeClientBody(call(name), new Set([basename])).forward;

// The prefixes one live Home Assistant published at once, measured on
// 2026-09-18. The suffix is not the point — the prefix is, and there is more
// than one of it, which is why the rule cuts at the LAST `__` rather than
// stripping a known word.
const PREFIXES = ['assist_satellite__', 'homeassistant__', 'intent__', 'llm__', 'media_player__', 'todo__'];

test('every published prefix resolves to the same basename, in the leaf and at the gate', () => {
  for (const prefix of PREFIXES) {
    const wire = `${prefix}GetLiveContext`;
    assert.equal(haBasename(wire), 'GetLiveContext', wire);
    // The gate allows exactly what the leaf named, and nothing else.
    assert.equal(allows(wire, haBasename(wire)), true, wire);
    assert.equal(allows(wire, wire), false, wire);
    assert.equal(allows(wire, 'HassTurnOn'), false, wire);
  }
});

test('a name with no prefix is its own basename', () => {
  assert.equal(haBasename('GetLiveContext'), 'GetLiveContext');
  assert.equal(allows('GetLiveContext', 'GetLiveContext'), true);
});

test('a name that is nothing but a prefix has an empty basename, and the gate agrees', () => {
  // No server was seen to publish this. It is here because the leaf and the gate
  // must not disagree about it: whatever the rule answers, the gate answers the
  // same, so a name like this can never be allowed by one and refused by the other.
  assert.equal(haBasename('todo__'), '');
  assert.equal(allows('todo__', ''), true);
  assert.equal(allows('todo__', 'todo__'), false);
});
