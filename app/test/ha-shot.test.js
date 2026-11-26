'use strict';

// ha-shot sends the Home Assistant token to HA_URL. The add-on's start script
// always exports that address, derived from the Supervisor; the tool must not
// guess one, because the name a guess would use can resolve to a real Home
// Assistant on the network of whatever machine runs it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HA_SHOT = path.join(__dirname, '..', '..', 'ha-tools', 'ha-shot.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-playwright.js');

function haShot(env) {
  return spawnSync(process.execPath, ['--require', FAKE, HA_SHOT, '/lovelace/0'], {
    env: { PATH: process.env.PATH, HA_TOKEN: 'test-token', ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

for (const [name, env] of [
  ['unset', {}],
  ['empty', { HA_URL: '' }],
  ['unset with a Supervisor token present', { SUPERVISOR_TOKEN: 'test-supervisor' }],
]) {
  test(`ha-shot refuses before starting a browser when HA_URL is ${name}`, () => {
    const run = haShot(env);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /HA_URL is not set/);
    assert.equal(run.stdout, '');
  });
}

test('ha-shot opens the dashboard on the origin of an explicit HA_URL', () => {
  const run = haShot({ HA_URL: 'https://127.0.0.1:8443/ignored' });
  assert.equal(run.stdout, 'launched\ngoto https://127.0.0.1:8443/lovelace/0\n');
});
