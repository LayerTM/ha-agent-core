'use strict';

// The release archive carries every file's mode from git, and the consumer
// verifier installs it as is. A command the image runs is therefore executable
// only if git records it so.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');

test('every file in a bin directory under rootfs/ is executable, and a command', () => {
  const entries = execFileSync('git', ['-C', REPO, 'ls-files', '-s', '-z', '--', 'rootfs'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      return { mode: meta.split(' ')[0], file };
    })
    .filter(({ file }) => /(^|\/)bin\/[^/]+$/.test(file));
  assert.ok(entries.length >= 11, `only ${entries.length} commands found`);
  const wrong = entries.filter(({ mode }) => mode !== '100755').map(({ file, mode }) => `${file} (${mode})`);
  assert.deepEqual(wrong, []);
});
