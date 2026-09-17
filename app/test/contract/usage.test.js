'use strict';

// /api/usage end to end: the prompt server runs the core's ha-usage, which asks
// the engine's agent-usage (here the neutral one) for console usage and reads
// prompt runs from the audit log. Also the example of the rule that keeps a run
// from being counted twice: a prompt run leaves agent-usage's output unchanged.
// Each real engine checks that rule in its own add-on's tests.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-usage-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The server hands ha-usage only PATH and HOME, so HOME selects the case.
process.env.HOME = path.join(TMP, 'home');
process.env.CLAUDE_PROMPT_TIMEOUT_MS = '10000';

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter, okTape } = require('../fixtures/neutral-adapter');
const { adapter, state, branding } = createNeutralAdapter();
useAdapter(adapter, branding);
const { createPromptApp, USAGE_TIMEOUT_MS, USAGE_READER_TIMEOUT_MS } = require('../../server/prompt/server');
const { run } = require('../../server/prompt/run');

const HA_USAGE = path.join(__dirname, '..', '..', '..', 'rootfs', 'usr', 'local', 'bin', 'ha-usage');
const AGENT_USAGE = path.join(__dirname, '..', 'fixtures', 'neutral-agent-usage.js');
const TOKEN = 'usage-token-0123456789abcdef';
const today = new Date().toISOString().slice(0, 10);

// ha-usage as the add-on installs it, pointed at the neutral reader and a data dir.
const USAGE_BIN = path.join(TMP, 'ha-usage');
fs.writeFileSync(USAGE_BIN, `#!/bin/sh\nCC_USAGE_AGENT_CMD=${JSON.stringify(AGENT_USAGE)} `
  + `CC_AUDIT_DATA_DIR=${JSON.stringify(TMP)} exec python3 ${JSON.stringify(HA_USAGE)} "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(TMP, 'claude-audit.log'),
  `${today} 10:00:01  prompt[read] caller=a status=200 tokens=m:7:8:0:0 cost=unknown\n`);

function home(files) {
  const root = path.join(process.env.HOME, '.neutral');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  // Each case starts from an empty usage cache.
  for (const name of ['usage-cache.json', 'usage-cache.json.1']) fs.rmSync(path.join(TMP, name), { force: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
}

async function getUsage() {
  const app = createPromptApp({
    token: TOKEN, claudeBin: path.join(TMP, 'no-agent'), usageBin: USAGE_BIN, haConfigured: false, mcpConfigPath: null,
    model: '', workDir: TMP, addonVersion: 'usage', redact: (s) => s, audit: () => {},
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/usage`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const line = (input, output) => `${JSON.stringify({ day: today, model: 'neutral-1', input, output, cache_read: 0, cache_write: 0 })}\n`;

test('console usage from the engine and prompt runs from the audit log add up', async () => {
  home({ 'sessions/a.jsonl': line(1, 2) + line(3, 4) });
  const { status, body } = await getUsage();
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.equal(body.projects, path.join(process.env.HOME, '.neutral', 'sessions'));
  assert.deepEqual(body.tokens.today, { input: 11, output: 14, cache_read: 0, cache_write: 0 });
  assert.deepEqual(Object.keys(body.by_model_recent).sort(), ['m', 'neutral-1']);
  assert.equal(body.messages.today, 2);
});

test('an engine that reports no usage is "not available", and prompt runs still count', async () => {
  home({ unreported: '' });
  const { status, body } = await getUsage();
  assert.equal(status, 200);
  assert.equal(body.available, false);
  assert.equal(body.projects, '');
  assert.deepEqual(body.tokens.today, { input: 7, output: 8, cache_read: 0, cache_write: 0 });
  assert.equal(body.messages.all_time, 0);
});

test('a reader that fails leaves console usage out and says why; prompt runs still count', async () => {
  home({ broken: '' });
  const { status, body } = await getUsage();
  assert.equal(status, 200);
  assert.equal(body.available, false);
  assert.equal(body.error, 'agent-usage exited 1: neutral usage reader broke');
  assert.deepEqual(body.tokens.today, { input: 7, output: 8, cache_read: 0, cache_write: 0 });
});

test('the reader\'s time budget is passed down and fits inside the server\'s own', async () => {
  home({ 'sessions/a.jsonl': line(1, 2), 'record-budget': '' });
  const { status } = await getUsage();
  assert.equal(status, 200);
  const passed = fs.readFileSync(path.join(process.env.HOME, '.neutral', 'budget'), 'utf8');
  assert.equal(Number(passed), USAGE_READER_TIMEOUT_MS);
  assert.ok(USAGE_READER_TIMEOUT_MS + 5000 <= USAGE_TIMEOUT_MS, 'the rest of the report keeps at least 5 s');
});

test('example of the rule: a prompt run leaves the engine\'s usage output unchanged', async () => {
  home({ 'sessions/a.jsonl': line(1, 2) });
  // What the engine would give the core: its files, and what they hold.
  const read = () => {
    const files = execFileSync(AGENT_USAGE, ['--files'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    return files.split('\0').filter(Boolean).map((file) => [file, fs.readFileSync(file, 'utf8')]);
  };
  const before = read();
  state.tapes.push(okTape('answer'));
  const outcome = await run({ bin: process.execPath, mode: 'read', prompt: 'hello', intents: [], cwd: TMP });
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(read(), before);
  assert.equal(before.length, 1);
});

test('a second request reads only what was appended, and the files are not re-read', async () => {
  home({ 'sessions/a.jsonl': line(1, 2) });
  assert.deepEqual((await getUsage()).body.tokens.today, { input: 8, output: 10, cache_read: 0, cache_write: 0 });
  fs.appendFileSync(path.join(process.env.HOME, '.neutral', 'sessions', 'a.jsonl'), line(5, 6));
  // The prompt server keeps a report for a while; a fresh app asks again.
  const { body } = await getUsage();
  assert.deepEqual(body.tokens.today, { input: 13, output: 16, cache_read: 0, cache_write: 0 });
  const cache = JSON.parse(fs.readFileSync(path.join(TMP, 'usage-cache.json'), 'utf8'));
  assert.equal(cache.last_read_bytes, Buffer.byteLength(line(5, 6)));
});
