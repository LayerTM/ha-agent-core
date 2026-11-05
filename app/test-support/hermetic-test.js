#!/usr/bin/env node
'use strict';

/* global require, process, __dirname, console */

// Runs a test command so that it cannot reach another machine, and fails it if it
// tried. Production code talks to `homeassistant` on purpose, and on a developer's
// network that name can resolve to a real home, where a test's made-up token is a
// failed login. Every test script of the core goes through here:
//
//   node test-support/hermetic-test.js node --test "test/**/*.test.js"
//
// Node processes get hermetic-preload.js and `curl` and `wget` are found in bin/
// first. Both let loopback through and refuse the rest. What they refused is
// written to one record, and a non-empty record fails the run whatever the command
// itself returned. The check at the start makes a guard that stopped working a
// failure instead of a quiet pass; it aims at TEST-NET-1, which is never routed.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRELOAD = path.join(__dirname, 'hermetic-preload.js');
const BIN = path.join(__dirname, 'bin');
const REFUSED = 'ERR_HERMETIC_NETWORK';

const SELF_CHECK = `
  require('node:net').connect(9, '192.0.2.1')
    .on('connect', () => process.exit(1))
    .on('error', (err) => process.exit(err.code === '${REFUSED}' ? 0 : 1));
  setTimeout(() => process.exit(1), 5000);
`;

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('usage: hermetic-test.js COMMAND [ARG...]');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-'));
const record = path.join(dir, 'refused');
fs.writeFileSync(record, '');
const env = {
  ...process.env,
  HERMETIC_RECORD: record,
  NODE_OPTIONS: `--require "${PRELOAD}" ${process.env.NODE_OPTIONS || ''}`.trim(),
  PATH: `${BIN}${path.delimiter}${process.env.PATH || ''}`,
};

function finish(code) {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const check = spawnSync(process.execPath, ['-e', SELF_CHECK], { env, stdio: 'inherit' });
if (check.status !== 0 || fs.readFileSync(record, 'utf8') === '') {
  console.error('FAIL: the hermetic guard did not refuse its own check; the tests were not run');
  finish(2);
}
fs.writeFileSync(record, '');

const run = spawnSync(command[0], command.slice(1), { env, stdio: 'inherit' });
if (run.error) console.error(`FAIL: ${command[0]}: ${run.error.message}`);
const refused = fs.readFileSync(record, 'utf8');
if (refused !== '') {
  console.error(`\nFAIL: this test run tried to leave the machine:\n\n${refused}`);
  finish(1);
}
finish(run.status === null ? 1 : run.status);
