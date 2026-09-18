'use strict';

// What the start-up log says about the Home Assistant token must be an answer
// from Home Assistant, not the shape of the option. Until 0.7.4 a non-empty text
// box was logged as "HA Token configured (… enabled)", and a token Home Assistant
// answers 401 to produced exactly that line.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');
const RUN = fs.readFileSync(path.join(REPO, 'rootfs', 'usr', 'local', 'bin', 'addon-run'), 'utf8');

test('the start-up script loads the token check and asks with it', () => {
  assert.match(RUN, /^source \/usr\/local\/lib\/ha-token-check\.sh$/m);
  assert.match(RUN, /ha_token_status "\$\{HA_URL\}" "\$\{ha_token\}"/);
});

test('each of the three answers is logged at its own level', () => {
  for (const [verdict, level] of [['accepted', 'info'], ['rejected', 'error']]) {
    const line = new RegExp(`${verdict}\\) bashio::log\\.${level} "\\$\\(ha_token_sentence`);
    assert.match(RUN, line, verdict);
  }
  assert.match(RUN, /\*\) bashio::log\.warning "\$\(ha_token_sentence/);
});

test('a token is no longer called enabled for being present', () => {
  assert.doesNotMatch(RUN, /HA Token configured/);
});
