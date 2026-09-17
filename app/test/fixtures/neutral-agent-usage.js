#!/usr/bin/env node
'use strict';

// The neutral engine's agent-usage. Its session files under
// $HOME/.neutral/sessions hold one usage record per line, already in the
// contract's shape, so `--parse` only passes them through; its state is the
// number of lines it has seen in a file. $HOME/.neutral/unreported makes it exit
// 3 (the engine reports no usage), $HOME/.neutral/broken exit 1; with
// $HOME/.neutral/record-budget it writes the time budget it was given.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const root = path.join(process.env.HOME || '', '.neutral');
const sessions = path.join(root, 'sessions');

if (fs.existsSync(path.join(root, 'record-budget'))) {
  fs.writeFileSync(path.join(root, 'budget'), process.env.CC_USAGE_READER_TIMEOUT_MS || '');
}
if (fs.existsSync(path.join(root, 'unreported'))) process.exit(3);
if (fs.existsSync(path.join(root, 'broken'))) {
  process.stderr.write('neutral usage reader broke\n');
  process.exit(1);
}

switch (process.argv[2]) {
  case '--source':
    process.stdout.write(`${sessions}\n`);
    break;
  case '--files': {
    let names = [];
    try {
      names = fs.readdirSync(sessions).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      // No sessions yet.
    }
    process.stdout.write(names.map((name) => `${path.join(sessions, name)}\0`).join(''));
    break;
  }
  case '--parse': {
    let seen = 0;
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', (raw) => {
      const [kind, a, b] = JSON.parse(raw);
      if (kind === 'S') {
        seen = typeof b === 'number' ? b : 0;
        process.stdout.write('null\n');
      } else if (kind === 'L') {
        seen += 1;
        let record = null;
        try {
          record = JSON.parse(a);
        } catch {
          // Not a record.
        }
        process.stdout.write(`${JSON.stringify(record && typeof record === 'object' ? [record] : [])}\n`);
      } else {
        process.stdout.write(`${JSON.stringify({ state: seen })}\n`);
      }
    });
    break;
  }
  default:
    process.stderr.write('usage: agent-usage --files | --parse | --source\n');
    process.exit(64);
}
