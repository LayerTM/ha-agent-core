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
  // Loading the prompt server needs the adapter at load time.
  assert.throws(() => require('../../server/prompt/server'), (err) => err.code === 'MODULE_NOT_FOUND');
});
