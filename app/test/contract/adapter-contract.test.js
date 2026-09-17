'use strict';

// The adapter a core is assembled with is checked when it is loaded, so a wrong
// or incomplete one stops the add-on at startup.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../../server/adapter-contract');
const { createNeutralAdapter } = require('../fixtures/neutral-adapter');

function without(mod, dotted) {
  const copy = {
    ...mod,
    descriptor: { ...mod.descriptor },
    runner: { ...mod.runner },
    prompt: { ...mod.prompt },
    console: { ...mod.console },
  };
  const [part, key] = dotted.split('.');
  delete copy[part][key];
  return copy;
}

test('the neutral adapter satisfies the contract', () => {
  const { adapter } = createNeutralAdapter();
  assert.equal(contract.validateAdapter(adapter), adapter);
});

test('a module that is not an object, or has another apiVersion, is refused', () => {
  const { adapter } = createNeutralAdapter();
  for (const mod of [null, undefined, 'adapter', () => adapter]) {
    assert.throws(() => contract.validateAdapter(mod), /does not export an object/);
  }
  for (const apiVersion of [undefined, 0, 1, 3, '2']) {
    assert.throws(() => contract.validateAdapter({ ...adapter, apiVersion }), /apiVersion/);
  }
});

test('every required member is enforced, one at a time', () => {
  const { adapter } = createNeutralAdapter();
  for (const dotted of Object.keys(contract.REQUIRED)) {
    assert.throws(
      () => contract.validateAdapter(without(adapter, dotted)),
      (err) => err.message.includes(dotted),
      `${dotted} missing was accepted`,
    );
  }
});

test('the adapter API the core speaks is the one its package declares', () => {
  const pkg = require('../../../package.json');
  assert.equal(pkg.haAgentCore.adapterApi, contract.API_VERSION);
});

test('an adapter without an engine descriptor is refused', () => {
  const { adapter } = createNeutralAdapter();
  const { descriptor, ...bare } = adapter;
  assert.ok(descriptor);
  assert.throws(() => contract.validateAdapter(bare), /descriptor\.engine must be a non-empty string/);
  assert.throws(() => contract.validateAdapter({ ...adapter, descriptor: null }), /descriptor\.engine/);
});

test('the engine name is a stable lower-case token', () => {
  const { adapter } = createNeutralAdapter();
  for (const engine of ['codex', 'claude', 'agent-2', 'my_agent']) {
    const mod = { ...adapter, descriptor: { ...adapter.descriptor, engine } };
    assert.equal(contract.validateAdapter(mod), mod, engine);
  }
  for (const engine of ['Claude', '2agent', 'a b', 'agent/x', 'x'.repeat(33), 42]) {
    assert.throws(
      () => contract.validateAdapter({ ...adapter, descriptor: { ...adapter.descriptor, engine } }),
      /descriptor\.engine/,
      String(engine),
    );
  }
});

test('the version alias may be absent, but only a separate *_version key when present', () => {
  const { adapter } = createNeutralAdapter();
  assert.equal(adapter.descriptor.versionAlias, undefined);
  const aliased = { ...adapter, descriptor: { ...adapter.descriptor, versionAlias: 'neutral_version' } };
  assert.equal(contract.validateAdapter(aliased), aliased);
  for (const versionAlias of ['', 'engine_version', 'version', 'neutral', 'Neutral_version', 7]) {
    assert.throws(
      () => contract.validateAdapter({ ...adapter, descriptor: { ...adapter.descriptor, versionAlias } }),
      /descriptor\.versionAlias/,
      String(versionAlias),
    );
  }
});

test('a required member of the wrong type, or an empty string, is refused', () => {
  const { adapter } = createNeutralAdapter();
  assert.throws(() => contract.validateAdapter({ ...adapter, runner: { ...adapter.runner, run: 'run' } }), /runner\.run must be a function/);
  assert.throws(() => contract.validateAdapter({ ...adapter, runner: { ...adapter.runner, TIMEOUT_MS: '5000' } }), /TIMEOUT_MS must be a number/);
  assert.throws(() => contract.validateAdapter({ ...adapter, console: { ...adapter.console, launcher: '' } }), /console\.launcher must be a non-empty string/);
  assert.throws(() => contract.validateAdapter({ ...adapter, prompt: null }), /prompt\./);
});

test('the optional remote window may be absent, but not malformed', () => {
  const { adapter } = createNeutralAdapter();
  assert.equal(adapter.console.remoteWindow, undefined);
  const withRemote = { ...adapter, console: { ...adapter.console, remoteWindow: () => null } };
  assert.equal(contract.validateAdapter(withRemote), withRemote);
  assert.throws(
    () => contract.validateAdapter({ ...adapter, console: { ...adapter.console, remoteWindow: 'remote' } }),
    /console\.remoteWindow must be a function when present/,
  );
});

test('an adapter can be installed once, before first use, and only a valid one', () => {
  const { adapter } = createNeutralAdapter();
  assert.throws(() => contract.useAdapter({ ...adapter, apiVersion: 1 }), /apiVersion/);
  assert.equal(contract.useAdapter(adapter), adapter);
  assert.equal(contract.adapter(), adapter);
  assert.throws(() => contract.useAdapter(adapter), /already loaded/);
});
