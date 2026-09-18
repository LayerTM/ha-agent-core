'use strict';

// Every background loop the add-on starts must speak into the add-on's log, and
// that is said in ONE place (rootfs/usr/local/lib/background-loop.sh). This reads
// the start-up script itself, because the fact is about how the loops are
// STARTED: a loop launched with `>/data/<name>.log` is invisible in the Log tab
// whatever the library does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');
const RUN = path.join(REPO, 'rootfs', 'usr', 'local', 'bin', 'addon-run');
const LOOPS = ['usage-upkeep', 'cc-monitor', 'cc-digest', 'cc-alerts'];

const script = fs.readFileSync(RUN, 'utf8');

test('the start-up script loads the one place that decides where a loop speaks', () => {
  assert.match(script, /^source \/usr\/local\/lib\/background-loop\.sh$/m);
});

test('every background loop is started through it', () => {
  for (const loop of LOOPS) {
    const started = new RegExp(`start_background_loop ${loop}\\b[^\\n]*/usr/local/bin/${loop}\\b`);
    assert.match(script, started, loop);
  }
});

test('no loop is started into a file inside the container', () => {
  // The provisioning block is not a loop and announces its file to the user in
  // the very next log line, so it is named here rather than matched by accident.
  const offenders = script
    .split('\n')
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => LOOPS.some((loop) => line.includes(`/usr/local/bin/${loop}`)))
    .filter(({ line }) => /> *\/data\/[^\s]*\.log/.test(line))
    .map(({ line, at }) => `${at}: ${line.trim()}`);
  assert.deepEqual(offenders, []);
});
