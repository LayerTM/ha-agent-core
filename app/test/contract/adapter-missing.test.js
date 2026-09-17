'use strict';

// Without an installed adapter the core looks for the real module and nothing
// else: there is no fallback, so a core without an adapter cannot serve.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the core has no adapter of its own to fall back on', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'adapter')), false);
  const contract = require('../../server/adapter-contract');
  assert.throws(() => contract.adapter(), (err) => err.code === 'MODULE_NOT_FOUND');
  // Anything the prompt server needs from the engine goes through that loader.
  const { run } = require('../../server/prompt/run');
  return run({ bin: '/nonexistent', mode: 'read', prompt: 'x', intents: [] }).then((outcome) => {
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.reason, 'spawn-failed');
    assert.match(outcome.message, /'\.\.\/adapter'/);
  });
});
