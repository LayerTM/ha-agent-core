'use strict';

// The startup placeholder runs before npm has installed anything and before the
// adapter can be trusted to load: it must start from its own files alone. It
// reads the adapter's names as data when they are there.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TEST_HOST, reportedPort, assertPortHeld } = require('../fixtures/bound-port');
const { NEUTRAL_BRANDING } = require('../fixtures/neutral-adapter');

const SERVER = path.join(__dirname, '..', '..', 'server');

// Starts the placeholder from a tree holding only its own files, the adapter's
// branding.json when given, and no page file. Resolves to its page and output.
async function placeholderPage(t, branding) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'core-starting-'));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tree, 'server'));
  for (const name of ['starting.js', 'sources.js', 'branding.js']) {
    fs.copyFileSync(path.join(SERVER, name), path.join(tree, 'server', name));
  }
  if (branding) {
    fs.mkdirSync(path.join(tree, 'adapter'));
    fs.writeFileSync(path.join(tree, 'adapter', 'branding.json'), JSON.stringify(branding));
  }
  const child = spawn(process.execPath, [path.join(tree, 'server', 'starting.js')], {
    cwd: tree,
    env: { PATH: process.env.PATH, CLAUDE_CONSOLE_PORT: '0', CLAUDE_CONSOLE_HOST: TEST_HOST, CLAUDE_CONSOLE_DEV: '1', NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let output = '';
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const port = reportedPort(output, 'Startup placeholder');
      if (port !== null) resolve(port);
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${output}`)));
  });
  const port = await listening;
  assert.ok(port > 0, output);
  await assertPortHeld(assert, port);
  const health = await fetch(`http://${TEST_HOST}:${port}/api/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false, starting: true });
  const page = await fetch(`http://${TEST_HOST}:${port}/`);
  assert.equal(page.status, 200);
  return { page: await page.text(), output };
}

test('the placeholder starts with no node_modules, no adapter and no page file', async (t) => {
  const { page, output } = await placeholderPage(t, null);
  assert.match(page, /<title>Starting…<\/title>[\s\S]*Starting the console/);
  assert.match(output, /starting page unavailable/);
  assert.match(output, /branding: .*branding\.json cannot be read.*; the page has no product name/);
});

test('without a page file, the placeholder is titled with the adapter\'s product name', async (t) => {
  const { page } = await placeholderPage(t, NEUTRAL_BRANDING);
  assert.match(page, /<title>Neutral Agent<\/title>[\s\S]*Starting the console/);
});
