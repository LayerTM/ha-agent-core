'use strict';

// What the running console says about which core it is: only what the archive's
// core-version.json states, and nothing it does not (test/pack.test.js checks
// that the packer writes that file and the shipped reader finds it).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { readCoreVersion, describeCore } = require('../server/core-version');

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function stated(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'core-version.json');
  if (text !== null) fs.writeFileSync(file, text);
  return file;
}

test('reads the version and commit the file states', (t) => {
  const file = stated(t, JSON.stringify({ version: '3.2.1', commit: COMMIT }));
  assert.deepEqual(readCoreVersion(file), { version: '3.2.1', commit: COMMIT });
});

test('a missing, unreadable or malformed file states nothing', (t) => {
  for (const text of [null, 'not json', 'null', '[]', JSON.stringify({ version: 'v1.2', commit: 'abc' })]) {
    assert.deepEqual(readCoreVersion(stated(t, text)), { version: '', commit: '' }, String(text));
  }
});

test('the log names the release, its commit when known, or that it is unknown', () => {
  assert.equal(describeCore({ version: '3.2.1', commit: COMMIT }), 'core 3.2.1, commit 0123456789ab');
  assert.equal(describeCore({ version: '3.2.1', commit: '' }), 'core 3.2.1');
  assert.equal(describeCore({ version: '', commit: COMMIT }), 'core version unknown');
});
