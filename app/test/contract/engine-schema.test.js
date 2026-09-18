'use strict';

// Which SCHEMA an engine is given for an answer — and the fact it is decided by.
//
// The answer contract is one, for every engine (READ_ANSWER / WRITE_ANSWER in
// run.js). What differs is what an engine can be TOLD about it: an engine whose
// structured output must close every object cannot be given a schema that
// contains an open one, and measured 2026-09-18 it refuses the request outright
// rather than ignoring the part it dislikes. So such an engine is given no
// schema for such an answer, and the prompt plus the core's own validation carry
// the shape — which is what decided the answer in the first place.
//
// Both directions are asserted here: an engine that declares nothing must get
// byte-for-byte the schema it gets today.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useAdapter, validateAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter } = require('../fixtures/neutral-adapter');

const { adapter, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const core = require('../../server/prompt/run');

const spec = (mode) => core.launchSpec({ mode, intents: [], haTools: [], stream: false });

function withClosedSchemas(fn) {
  adapter.descriptor.closedSchemasOnly = true;
  try { fn(); } finally { delete adapter.descriptor.closedSchemasOnly; }
}

test('an engine that declares nothing is given exactly the schemas it gets today', () => {
  assert.equal(adapter.descriptor.closedSchemasOnly, undefined, 'the fixture declares nothing');
  assert.equal(spec('read').schema, core.READ_SCHEMA);
  assert.equal(spec('write').schema, core.WRITE_SCHEMA);
});

test('an engine that can only take closed schemas is given none for the read answer', () => {
  withClosedSchemas(() => {
    assert.equal(spec('read').schema, '', 'the read answer carries open objects');
    assert.equal(spec('write').schema, core.WRITE_SCHEMA, 'the write answer has none, so it keeps its schema');
  });
});

test('declaring it changes nothing else about the run spec', () => {
  const plain = spec('read');
  withClosedSchemas(() => {
    const closed = spec('read');
    assert.deepEqual({ ...closed, schema: null }, { ...plain, schema: null });
  });
});

test('the decision is the open object, not the mode', () => {
  assert.equal(core.hasOpenObject(core.READ_ANSWER), true, 'data and the automation blocks are open');
  assert.equal(core.hasOpenObject({ type: 'object', properties: { text: { type: 'string' } } }), false);
  assert.equal(core.hasOpenObject({ type: 'array', items: { type: 'object' } }), true, 'an array of open objects');
  // An EMPTY property list is not an open object: it compiles to a closed object
  // that admits nothing, which a strict structured output accepts — and which is
  // therefore useless for `data`, but it is not what this predicate is looking for.
  assert.equal(core.hasOpenObject({ type: 'object', properties: { a: { type: 'object', properties: {} } } }), false);
  assert.equal(core.hasOpenObject({ type: 'string' }), false);
});

test('the capability is a boolean or absent, and the contract says so', () => {
  const base = () => createNeutralAdapter().adapter;
  const good = base();
  good.descriptor.closedSchemasOnly = true;
  assert.doesNotThrow(() => validateAdapter(good));
  const bad = base();
  bad.descriptor.closedSchemasOnly = 'yes';
  assert.throws(() => validateAdapter(bad), /closedSchemasOnly must be a boolean/);
});
