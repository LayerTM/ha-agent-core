'use strict';

// A bearer is handed to curl in ONE place (rootfs/usr/local/lib/ha-curl.sh), on
// stdin. The shape of the defect that made this rule — eleven calls each writing
// `-H "Authorization: Bearer ..."` themselves, and every one of them putting the
// token into a world-readable command line — comes back the moment a twelfth call
// is written the old way, so the whole shell layer is read here.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');
const HELPER = 'rootfs/usr/local/lib/ha-curl.sh';

const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', 'rootfs'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

test('the shell layer was read at all', () => {
  assert.ok(files.length >= 15, `only ${files.length} files under rootfs/`);
  assert.ok(files.includes(HELPER), `${HELPER} is not tracked`);
});

test('only the helper writes an Authorization header', () => {
  const offenders = files
    .filter((file) => file !== HELPER)
    .flatMap((file) => fs.readFileSync(path.join(REPO, file), 'utf8')
      .split('\n')
      .map((line, i) => ({ file, at: i + 1, line }))
      .filter(({ line }) => /Authorization:\s*Bearer/i.test(line)))
    .map(({ file, at, line }) => `${file}:${at}: ${line.trim()}`);
  assert.deepEqual(offenders, []);
});

test('the helper keeps the token out of the command line', () => {
  const helper = fs.readFileSync(path.join(REPO, HELPER), 'utf8');
  // The header reaches curl as a config on stdin (`-K -`), never as an argument.
  assert.match(helper, /-K -/);
  const asArgument = helper
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))            // the prose may quote the old form
    .filter((line) => /-H\s+["']?Authorization/i.test(line));
  assert.deepEqual(asArgument, []);
});

test('every caller asks the helper for it', () => {
  const callers = files.filter((file) => /\/(bin|lib)\//.test(file) && file !== HELPER)
    .filter((file) => /\bha_curl\b/.test(fs.readFileSync(path.join(REPO, file), 'utf8')));
  assert.ok(callers.length >= 9, `only ${callers.length} callers use ha_curl`);
  const unsourced = callers.filter((file) => !/source\s+\S*ha-curl\.sh/.test(
    fs.readFileSync(path.join(REPO, file), 'utf8'),
  ));
  assert.deepEqual(unsourced, []);
});
