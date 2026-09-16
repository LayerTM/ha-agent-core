'use strict';

// The adapter a core is assembled with is checked when it is loaded, so a wrong
// or incomplete one stops the add-on at startup.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../../server/adapter-contract');
const { createNeutralAdapter } = require('../fixtures/neutral-adapter');

function without(mod, dotted) {
  const copy = { ...mod, runner: { ...mod.runner }, prompt: { ...mod.prompt }, console: { ...mod.console } };
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
  for (const apiVersion of [undefined, 0, 2, '1']) {
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
  assert.throws(() => contract.useAdapter({ ...adapter, apiVersion: 2 }), /apiVersion/);
  assert.equal(contract.useAdapter(adapter), adapter);
  assert.equal(contract.adapter(), adapter);
  assert.throws(() => contract.useAdapter(adapter), /already loaded/);
});
