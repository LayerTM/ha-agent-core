'use strict';

// The list of files an add-on's secrets guard protects. The core ships it and an
// AppArmor profile and an agent hook read it, so its shape is a contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIST = path.join(__dirname, '..', '..', '..', 'rootfs', 'usr', 'share', 'agent-core', 'protected-paths.txt');
const entries = fs.readFileSync(LIST, 'utf8').split('\n').filter((line) => line !== '' && !line.startsWith('#'));

test('every entry is one absolute path, with nothing AppArmor would read otherwise', () => {
  assert.ok(entries.length > 0);
  for (const entry of entries) assert.match(entry, /^\/[^\s"',]+$/, entry);
});

test('the files that hold credentials are on it', () => {
  for (const entry of ['/homeassistant/secrets.yaml', '/homeassistant/.storage/auth', '/homeassistant/.storage/core.config_entries', '/ssl/*.key', '/backup/**']) {
    assert.ok(entries.includes(entry), entry);
  }
});
