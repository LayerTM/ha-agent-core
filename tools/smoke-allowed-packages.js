'use strict';

// Run in an installed app directory: every package allowed to run install
// scripts loads, and node-pty starts a terminal that prints what it was told to.
//
// The terminal is started on Linux only, where node-pty is built from source:
// node-pty 1.1.0 ships its macOS spawn-helper without the executable bit, so a
// prebuilt macOS copy cannot start one whatever this repository does.

const fs = require('node:fs');
const path = require('node:path');

const dir = process.cwd();
const pkg = require(path.join(dir, 'package.json'));
// An allowed package the install left out (npm ci --omit) is not there to load.
const allowed = Object.entries(pkg.allowScripts || {})
  .filter(([, on]) => on === true)
  .map(([name]) => name)
  .filter((name) => fs.existsSync(path.join(dir, 'node_modules', name, 'package.json')));
const load = (name) => require(require.resolve(name, { paths: [dir] }));

for (const name of allowed) load(name);

if (allowed.includes('node-pty') && process.platform === 'linux') {
  const term = load('node-pty').spawn('/bin/sh', ['-c', 'printf pty-ok'], {});
  let out = '';
  const timer = setTimeout(() => {
    console.error('node-pty: the terminal printed nothing');
    process.exit(1);
  }, 10000);
  term.onData((d) => { out += d; });
  term.onExit(() => {
    clearTimeout(timer);
    if (!out.includes('pty-ok')) {
      console.error(`node-pty: unexpected terminal output ${JSON.stringify(out)}`);
      process.exit(1);
    }
  });
}
