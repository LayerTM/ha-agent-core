'use strict';

// The startup placeholder runs before npm has installed anything and before the
// adapter can be trusted to load: it must start from its own files alone.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', 'server');

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('the placeholder starts with no node_modules, no adapter and no page file', async (t) => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'core-starting-'));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tree, 'server'));
  for (const name of ['starting.js', 'sources.js']) {
    fs.copyFileSync(path.join(SERVER, name), path.join(tree, 'server', name));
  }
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(tree, 'server', 'starting.js')], {
    cwd: tree,
    env: { PATH: process.env.PATH, CLAUDE_CONSOLE_PORT: String(port), CLAUDE_CONSOLE_DEV: '1', NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let output = '';
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('Startup placeholder listening')) resolve();
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${output}`)));
  });
  await listening;
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false, starting: true });
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Claude Code<\/title>[\s\S]*Starting the console/);
  assert.match(output, /starting page unavailable/);
});
