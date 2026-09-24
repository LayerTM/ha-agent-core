'use strict';

// Which SCHEMA an engine is given for an answer — and the fact it is decided by.
//
// The answer contract is one, for every engine (READ_ANSWER / WRITE_ANSWER in
// run.js). What differs is what an engine can be TOLD about it: an engine whose
// structured output must close every object cannot be given a schema that
// contains an open one (measured 2026-09-18, it refuses the request outright),
// and with no schema at all it answers in prose whenever the user asks for a
// format (measured 2026-09-24). So such an engine is given the CLOSED form of
// the same answer — every open object carried as a JSON-encoded string — and
// the core decodes it back before validating it as it always did.
//
// Both directions are asserted here: an engine that declares nothing must get
// byte-for-byte the schema it gets today, and the closed round trip must
// deliver exactly what the open one does.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { useAdapter, validateAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter } = require('../fixtures/neutral-adapter');

const { adapter, state, branding } = createNeutralAdapter();
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

test('an engine that can only take closed schemas is given the closed form of each answer', () => {
  withClosedSchemas(() => {
    assert.equal(spec('read').schema, core.READ_CLOSED_SCHEMA);
    assert.equal(spec('write').schema, core.WRITE_CLOSED_SCHEMA);
  });
  assert.equal(core.hasOpenObject(JSON.parse(core.READ_CLOSED_SCHEMA)), false, 'no open object is left');
  assert.equal(core.WRITE_CLOSED_SCHEMA, core.WRITE_SCHEMA, 'an answer with no open object is unchanged');
  assert.equal(core.hasOpenObject(core.closedOf(core.READ_ANSWER)), false);
});

test('the closed form renames exactly the open fields and keeps whether they may be null', () => {
  const read = JSON.parse(core.READ_CLOSED_SCHEMA);
  const intent = read.properties.proposal.properties.intents.items;
  assert.deepEqual(Object.keys(intent.properties), ['intent', 'targets', 'data_json', 'risk']);
  assert.deepEqual(intent.properties.data_json.type, ['string', 'null'], 'data stays optional');
  const auto = read.properties.automation;
  assert.deepEqual(auto.type, ['object', 'null']);
  assert.deepEqual(Object.keys(auto.properties),
    ['alias', 'description', 'triggers_json', 'conditions_json', 'actions_json', 'mode']);
  assert.equal(auto.properties.triggers_json.items.type, 'string');
  assert.deepEqual(auto.properties.conditions_json.type, ['array', 'null']);
});

test('declaring it changes nothing else about the run spec but one sentence of the read prompt', () => {
  const plain = { read: spec('read'), write: spec('write') };
  withClosedSchemas(() => {
    const closed = spec('read');
    assert.deepEqual({ ...closed, schema: null, systemPrompt: null }, { ...plain.read, schema: null, systemPrompt: null });
    assert.ok(closed.systemPrompt.startsWith(plain.read.systemPrompt));
    assert.match(closed.systemPrompt.slice(plain.read.systemPrompt.length), /X_json/);
    assert.equal(spec('write').systemPrompt, plain.write.systemPrompt);
  });
});

// --- the round trip, through a real run --------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-engine-schema-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function runWith(structured) {
  state.tapes.push([{ emit: { type: 'result', structured } }]);
  return core.run({ bin: process.execPath, mode: 'read', prompt: 'hello', intents: [], cwd: TMP });
}

const OPEN = {
  text: 'done',
  proposal: {
    summary: 'Dim',
    intents: [
      { intent: 'HassLightSet', targets: ['light.a'], data: { brightness: 40, color: { r: 1 } }, risk: 'low' },
      { intent: 'HassTurnOff', targets: ['light.b'], data: null, risk: 'low' },
    ],
  },
  automation: {
    alias: 'Night', description: 'Lights off', triggers: [{ trigger: 'time', at: '23:00:00' }], conditions: null,
    actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }], mode: 'single',
  },
};

// The same answer, as a closed engine must write it.
const CLOSED = {
  text: 'done',
  proposal: {
    summary: 'Dim',
    intents: OPEN.proposal.intents.map(({ data, ...rest }) => ({
      ...rest, data_json: data === null ? null : JSON.stringify(data),
    })),
  },
  automation: {
    alias: 'Night', description: 'Lights off', triggers_json: OPEN.automation.triggers.map((b) => JSON.stringify(b)),
    conditions_json: null, actions_json: OPEN.automation.actions.map((b) => JSON.stringify(b)), mode: 'single',
  },
};

test('a proposal with data and an automation draft come back from the closed form exactly as from the open one', async () => {
  const open = await runWith(OPEN);
  let closed;
  adapter.descriptor.closedSchemasOnly = true;
  try { closed = await runWith(CLOSED); } finally { delete adapter.descriptor.closedSchemasOnly; }
  assert.equal(open.status, 'ok');
  assert.notEqual(open.proposal, null);
  assert.deepEqual(open.proposal.intents[0].data, { brightness: 40, color: { r: 1 } });
  assert.notEqual(open.automation, null);
  assert.deepEqual(closed, open);
  assert.deepEqual(core.openFrom(CLOSED, core.READ_ANSWER), OPEN);
});

test('a string that is not the JSON object it stands for is a model error, never a dropped proposal', async () => {
  const broken = [
    ['not JSON', (a) => { a.proposal.intents[0].data_json = 'brightness: 40'; }],
    ['an array', (a) => { a.proposal.intents[0].data_json = '[1]'; }],
    ['a number', (a) => { a.automation.triggers_json[0] = '7'; }],
    ['empty', (a) => { a.automation.actions_json[0] = ''; }],
  ];
  adapter.descriptor.closedSchemasOnly = true;
  try {
    for (const [label, spoil] of broken) {
      const answer = structuredClone(CLOSED);
      spoil(answer);
      const outcome = await runWith(answer);
      assert.equal(outcome.status, 'error', label);
      assert.equal(outcome.reason, 'model-error', label);
      assert.match(outcome.message, /is not a JSON-encoded object/, label);
    }
  } finally { delete adapter.descriptor.closedSchemasOnly; }
});

test('an engine that declares nothing never has its answer decoded', async () => {
  const outcome = await runWith({ ...structuredClone(CLOSED), automation: null });
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.proposal.intents[0].data, {}, 'data_json is not a field of the open answer: nothing is decoded');
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
