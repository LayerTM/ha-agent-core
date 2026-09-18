'use strict';

// Two start-up calls ask Home Assistant something before anything has told Core
// to be up: the token check, and the question of where Core listens. How long to
// wait for it is one fact, and it is said in rootfs/usr/local/lib/ha-core-ready.sh.
// This reads the start-up script, because a call that asks directly is not
// waiting however patient the library is.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');
const RUN = path.join(REPO, 'rootfs', 'usr', 'local', 'bin', 'addon-run');
const LIB = path.join(REPO, 'rootfs', 'usr', 'local', 'lib', 'ha-core-ready.sh');

const script = fs.readFileSync(RUN, 'utf8');
const lib = fs.readFileSync(LIB, 'utf8');

test('the start-up script loads the one place that decides how long to wait', () => {
  assert.match(script, /^source \/usr\/local\/lib\/ha-core-ready\.sh$/m);
});

test('the call that asks where Core listens goes through the wait', () => {
  assert.match(script, /ha_awaiting_core core_info_once/);
  const direct = script
    .split('\n')
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => line.includes('supervisor/core/info'))
    .filter(({ line }) => !/^\s*#/.test(line));
  // The URL appears once, inside the function the wait calls.
  assert.equal(direct.length, 1, JSON.stringify(direct));
  const body = script.slice(script.indexOf('core_info_once() {'), script.indexOf('ha_awaiting_core core_info_once'));
  assert.ok(body.includes('supervisor/core/info'), 'the URL is not inside core_info_once');
  assert.match(body, /ha_core_still_starting/);
});

test('the budget is a number the library states once', () => {
  const declarations = lib.split('\n').filter((line) => /^HA_CORE_WAIT_SECONDS=/.test(line));
  assert.equal(declarations.length, 1, JSON.stringify(declarations));
  assert.match(declarations[0], /:-\d+\}/);
  const elsewhere = fs.readFileSync(path.join(REPO, 'rootfs', 'usr', 'local', 'lib', 'ha-token-check.sh'), 'utf8');
  assert.doesNotMatch(elsewhere, /HA_CORE_WAIT_SECONDS=/);
  assert.doesNotMatch(script, /HA_CORE_WAIT_SECONDS=/);
});

test('a refusal is not something to wait out', () => {
  // The codes worth another try are the ones that mean nothing answered; an
  // authentication answer is an answer.
  const [, codes] = lib.match(/^\s*(\S+)\)\s*return 0 ;;/m) || [];
  assert.ok(codes, 'the classifier lists no codes');
  assert.ok(!codes.split('|').includes('401'), `401 is treated as "not yet": ${codes}`);
  assert.ok(!codes.split('|').includes('403'), `403 is treated as "not yet": ${codes}`);
  assert.deepEqual(codes.split('|').sort(), ['000', '502', '503', '504']);
});
