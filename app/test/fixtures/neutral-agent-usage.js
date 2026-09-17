#!/usr/bin/env node
'use strict';

// The neutral engine's agent-usage: prints the lines of every session file under
// $HOME/.neutral/sessions, already in the contract's shape. $HOME/.neutral/unreported
// makes it exit 3 (the engine reports no usage), $HOME/.neutral/broken exit 1.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(process.env.HOME || '', '.neutral');
const sessions = path.join(root, 'sessions');

if (fs.existsSync(path.join(root, 'unreported'))) process.exit(3);
if (fs.existsSync(path.join(root, 'broken'))) {
  process.stderr.write('neutral usage reader broke\n');
  process.exit(1);
}
if (process.argv[2] === '--source') {
  process.stdout.write(`${sessions}\n`);
  process.exit(0);
}
let names = [];
try {
  names = fs.readdirSync(sessions).filter((name) => name.endsWith('.jsonl')).sort();
} catch {
  // No sessions yet.
}
for (const name of names) process.stdout.write(fs.readFileSync(path.join(sessions, name), 'utf8'));
