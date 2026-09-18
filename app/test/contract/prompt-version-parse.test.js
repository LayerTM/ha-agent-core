'use strict';

// An adapter whose version parser throws must cost the status its version, not
// the process: the parser runs inside a child-process callback, where an
// exception would otherwise end the server. Run in a separate process so a crash
// is observable as an exit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'parse-token-0123456789abcdef';

const CHILD = `
const fs = require('node:fs');
const path = require('node:path');
const { useAdapter } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'server', 'adapter-contract'))});
const { createNeutralAdapter } = require(${JSON.stringify(path.join(__dirname, '..', 'fixtures', 'neutral-adapter'))});
const { adapter, branding } = createNeutralAdapter();
adapter.descriptor.parseVersion = () => { throw new Error('version parse failed'); };
useAdapter(adapter, branding);
const { createPromptApp } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'server', 'prompt', 'server'))});
const tmp = process.env.PARSE_TMP;
const bin = path.join(tmp, 'agent');
fs.writeFileSync(bin, "#!/bin/sh\\nprintf 'neutral-agent 1.2.3\\\\n'\\n", { mode: 0o755 });
const app = createPromptApp({
  token: ${JSON.stringify(TOKEN)},
  claudeBin: bin,
  claudeSettings: 'neutral-settings',
  usageBin: path.join(tmp, 'no-usage'),
  haConfigured: false,
  model: 'neutral-model',
  workDir: tmp,
  addonVersion: 'parse',
  redact: (s) => s,
  audit: () => {},
});
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));
`;

test('a throwing version parser leaves the server running, without a version', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-parse-'));
  const child = spawn(process.execPath, ['-e', CHILD], {
    env: { ...process.env, PARSE_TMP: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.once('data', (d) => resolve(Number(String(d).trim())));
      exited.then((code) => reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    const status = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const first = await status();
    assert.equal(first.engine_version, '');
    assert.equal(first.ready, false);
    // Still serving after the parser threw, and the failed parse is settled.
    assert.equal((await status()).engine_version, '');
    assert.equal(child.exitCode, null, stderr);
  } finally {
    child.kill();
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
