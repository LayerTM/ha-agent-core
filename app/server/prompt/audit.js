'use strict';

const fs = require('node:fs');

// The audit log is the one file that says what was done to a home: one line per
// Home Assistant call a prompt run makes, in the shape the audit hook writes for
// a console run (see core-relay.js), plus the server's own `prompt[...]`
// narration. The append used to be fire-and-forget into an empty callback, which
// is the one place an error could have arrived — so a `/data` that was full or
// read-only produced an action nobody could point to afterwards, and it looked
// exactly like a recorded one.
//
// This sink keeps the fire-and-forget shape — nothing awaits a line — and adds
// back what the empty callback threw away: whether the record is still being
// kept. A line is written when Home Assistant answers, so a failed write can
// never be un-failed; the effect has already happened. What it CAN do is say so
// and let the next action be refused. That refusal is the server's decision, not
// this module's: here the state is published and the errno is named.

/**
 * @param {string} file the audit log
 * @param {{ now?: () => Date, appendFile?: typeof fs.appendFile, announce?: (line: string) => void }} [deps]
 */
function createAuditSink(file, { now = () => new Date(), appendFile = fs.appendFile, announce = console.error } = {}) {
  // The errno of the last append that failed, until one succeeds. null means the
  // record is being kept, as far as anything actually attempted can say.
  let code = null;
  let failures = 0;
  let writes = 0;
  // The code already on stderr, so a full disk costs one line and not one per
  // call — the announcement must not become the flood it reports.
  let announced = null;

  const failed = (err) => {
    failures += 1;
    code = (err && err.code) || 'UNKNOWN';
    if (announced === code) return;
    announced = code;
    announce(`[prompt] audit log ${file} cannot be written (${code}): Home Assistant actions are NOT being recorded, so acting is refused until a write succeeds`);
  };

  // A write that arrived: the record is being kept again, and the announcement
  // of the outage is balanced by one that says it is over.
  const cleared = () => {
    if (code === null) return;
    const recovered = code;
    code = null;
    announced = null;
    announce(`[prompt] audit log ${file} is writable again (was ${recovered}): the record is being kept and acting is allowed`);
  };

  const wrote = () => {
    writes += 1;
    cleared();
  };

  return {
    // One line, timestamped as the audit hook timestamps its own. Never throws:
    // a caller narrating a request cannot be made to handle a disk, and none of
    // them awaits this. The returned promise settles when the WRITE did, and
    // never rejects — it exists so a test can read the state after the write
    // rather than after a sleep, which is a race the runner wins sometimes.
    append(line) {
      const ts = now().toISOString().replace('T', ' ').slice(0, 19);
      return new Promise((resolve) => {
        appendFile(file, `${ts}  ${line}\n`, (err) => {
          if (err) failed(err);
          else wrote();
          resolve(code === null);
        });
      });
    },

    // Is the record being kept? Asked at the moment an action is about to be
    // decided, and published on /api/status. `code` is the errno, which is the
    // only part of this a person can act on: EROFS and EACCES are theirs to fix,
    // ENOSPC is a disk.
    state() {
      return { recording: code === null, code, failures, writes };
    },

    // Can this log be appended to AT ALL? Asked once at start, because the
    // permanent half of the failures (a read-only or unwritable /data) is a boot
    // fact, and a chat request should not be the way a user discovers it.
    //
    // It appends the EMPTY STRING: the file is created if it is missing and the
    // open mode is the real one, but not one byte reaches the log — a boot fact
    // written into the record it protects would be noise in the one file a user
    // reads to see what was done to their home.
    probe() {
      return new Promise((resolve) => {
        appendFile(file, '', (err) => {
          // A probe is not a line, so it is not counted as one; it still ends an
          // outage, because it proves the same thing a line would.
          if (err) failed(err);
          else cleared();
          resolve(code === null);
        });
      });
    },
  };
}

module.exports = { createAuditSink };
