'use strict';

// The audit sink: the one place that knows whether what a run does to a home is
// still being recorded. The errors are real ones from a real filesystem — the
// log path made a directory (EISDIR) — because the value under test is an errno
// arriving in a callback that used to be empty.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuditSink } = require('../../server/prompt/audit');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'core-audit-'));

test('a line that is written leaves the record kept, and the hook shape intact', async () => {
  const file = path.join(tmp(), 'claude-audit.log');
  const sink = createAuditSink(file, { announce: () => {} });
  // Awaited on the sink's own promise rather than after a sleep: a sleep long
  // enough on this machine is a race a slower runner wins.
  await sink.append('HassTurnOn run=9f2c1a04b7e2: {"name":"desk lamp"}');
  assert.deepEqual(sink.state(), { recording: true, code: null, failures: 0, writes: 1 });
  assert.match(
    fs.readFileSync(file, 'utf8'),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\x20{2}HassTurnOn run=9f2c1a04b7e2: \{"name":"desk lamp"\}\n$/,
  );
});

test('a write that fails is announced with its errno, once, and stops the record being kept', async () => {
  // The log path is a directory: every append fails with EISDIR, for the life of
  // the boot, exactly as a read-only /data would.
  const file = path.join(tmp(), 'claude-audit.log');
  fs.mkdirSync(file);
  const announced = [];
  const sink = createAuditSink(file, { announce: (line) => announced.push(line) });

  await sink.append('HassTurnOn run=1: {}');
  // The oracle: the reading is taken where the next action is decided, not from
  // the log. Reading the log cannot tell a swallowed failure from a line that was
  // never generated — both give an absent line — so the errno must be here.
  assert.equal(sink.state().recording, false);
  assert.equal(sink.state().code, 'EISDIR');
  assert.equal(sink.state().failures, 1);
  assert.equal(announced.length, 1);
  assert.match(announced[0], /EISDIR/);
  assert.match(announced[0], /NOT being recorded/);

  // A full disk must not turn one outage into one stderr line per call.
  await sink.append('HassTurnOff run=2: {}');
  await sink.append('HassTurnOff run=3: {}');
  assert.equal(sink.state().failures, 3);
  assert.equal(announced.length, 1, 'the announcement became the flood it reports');
});

test('a write that succeeds again ends the outage, and says so', async () => {
  const dir = tmp();
  const file = path.join(dir, 'claude-audit.log');
  fs.mkdirSync(file);
  const announced = [];
  const sink = createAuditSink(file, { announce: (line) => announced.push(line) });
  await sink.append('HassTurnOn run=1: {}');
  assert.equal(sink.state().recording, false);

  fs.rmdirSync(file);
  await sink.append('HassTurnOn run=2: {}');
  assert.deepEqual(sink.state(), { recording: true, code: null, failures: 1, writes: 1 });
  assert.equal(announced.length, 2);
  assert.match(announced[1], /writable again \(was EISDIR\)/);
});

test('the boot probe reads the real open mode and writes no byte into the log', async () => {
  const dir = tmp();
  const file = path.join(dir, 'claude-audit.log');

  // A log that does not exist yet: the probe creates it, and it is still empty.
  const fresh = createAuditSink(file, { announce: () => {} });
  assert.equal(await fresh.probe(), true);
  assert.equal(fs.statSync(file).size, 0);

  // A log with history: byte-identical across a successful probe, so a boot fact
  // never becomes a line in the one file a user reads.
  await fresh.append('HassTurnOn run=1: {}');
  const before = fs.readFileSync(file);
  assert.equal(await fresh.probe(), true);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fresh.state().writes, 1, 'the probe was counted as a recorded line');

  // An unwritable log: the probe is how a boot learns it, not a chat request.
  const blocked = path.join(dir, 'blocked.log');
  fs.mkdirSync(blocked);
  const failing = createAuditSink(blocked, { announce: () => {} });
  assert.equal(await failing.probe(), false);
  assert.equal(failing.state().code, 'EISDIR');
});

test('a probe that succeeds after a failure ends the outage without counting a line', async () => {
  const dir = tmp();
  const file = path.join(dir, 'claude-audit.log');
  fs.mkdirSync(file);
  const sink = createAuditSink(file, { announce: () => {} });
  assert.equal(await sink.probe(), false);
  fs.rmdirSync(file);
  assert.equal(await sink.probe(), true);
  assert.deepEqual(sink.state(), { recording: true, code: null, failures: 1, writes: 0 });
});

test('an announcer that throws neither ends the process nor swallows the state', async () => {
  // The body of an fs callback is the one place a throw has nowhere to go: it
  // leaves the process with an uncaught error. This test IS that detector — if
  // the guard is removed, the runner dies here rather than reporting a failure.
  // Production passes no announcer, so this is the latent path the module's own
  // "never throws" promises against, held by a test rather than by a comment.
  const dir = tmp();
  const file = path.join(dir, 'claude-audit.log');
  fs.mkdirSync(file);
  const broken = () => { throw new Error('the announcer is broken'); };
  const sink = createAuditSink(file, { announce: broken });

  assert.equal(await sink.probe(), false);
  assert.equal(sink.state().code, 'EISDIR');

  assert.equal(await sink.append('HassTurnOn run=1: {}'), false);
  // The state is assigned before the announcement, so a lost announcement never
  // leaves the record's state wrong.
  assert.equal(sink.state().recording, false);
  assert.equal(sink.state().failures, 2);

  fs.rmdirSync(file);
  assert.equal(await sink.append('HassTurnOn run=2: {}'), true);
  assert.deepEqual(sink.state(), { recording: true, code: null, failures: 2, writes: 1 });
});
