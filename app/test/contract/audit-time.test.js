'use strict';

// One audit file, several writers, one clock. A writer that stamped its lines in
// local time put them on a different timeline from the prompt server's (UTC),
// and ha-usage groups the file by day. The writers are DISCOVERED by who names
// the file, so a new one fails here until it is covered; the clock is run under
// a zone far from UTC so a local-time stamp cannot pass by coincidence.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createAuditSink } = require('../../server/prompt/audit');

const ROOT = path.join(__dirname, '..', '..', '..');
const SHAPE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) {2}/;
const FAR_ZONE = { ...process.env, TZ: 'Pacific/Kiritimati' }; // UTC+14, no DST

const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const seconds = (stamp) => Date.parse(`${stamp.replace(' ', 'T')}Z`) / 1000;
function assertUtcNow(line, who) {
  const m = SHAPE.exec(line);
  assert.ok(m, `${who}: a line begins with a UTC stamp, got ${JSON.stringify(line)}`);
  assert.ok(Math.abs(seconds(m[1]) - seconds(utcNow())) <= 5, `${who}: ${m[1]} is not UTC now (${utcNow()})`);
}

// Every file under the shipped trees that names the audit log, relative.
function namingFiles() {
  const names = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'test'].includes(e.name)) walk(p); continue; }
      if (fs.readFileSync(p, 'utf8').includes('claude-audit.log')) names.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'rootfs'));
  walk(path.join(ROOT, 'app', 'server'));
  return names.sort();
}

// What does not write a line: it names the file to read it.
const READERS = new Set(['rootfs/usr/local/bin/ha-audit', 'rootfs/usr/local/bin/ha-usage']);
// The writers, each tested below; one the discovery turns up that is not here fails.
const WRITERS = ['app/server/prompt/index.js', 'rootfs/usr/local/bin/cc-hook-audit', 'rootfs/usr/local/bin/cc-hook-backup'];

test('every writer of the audit log is known, and none is left uncovered', () => {
  assert.deepEqual(namingFiles().filter((f) => !READERS.has(f)), WRITERS);
});

test('the prompt server stamps in UTC under a far zone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-audit-time-'));
  const file = path.join(dir, 'claude-audit.log');
  const sink = createAuditSink(file, { announce: () => {} });
  await sink.append('x');
  assertUtcNow(fs.readFileSync(file, 'utf8'), 'prompt sink');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cc-hook-audit stamps in UTC under a far zone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-audit-time-'));
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/config/automations.yaml' }, tool_response: {} });
  const r = spawnSync('bash', [path.join(ROOT, 'rootfs/usr/local/bin/cc-hook-audit')], { input, env: { ...FAR_ZONE, CC_AUDIT_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assertUtcNow(fs.readFileSync(path.join(dir, 'claude-audit.log'), 'utf8'), 'cc-hook-audit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shell stamp itself is UTC, and cc-hook-backup takes it from there', () => {
  const lib = path.join(ROOT, 'rootfs/usr/local/lib/audit-time.sh');
  const r = spawnSync('bash', ['-c', `source "${lib}"; audit_timestamp`], { env: FAR_ZONE, encoding: 'utf8' });
  assertUtcNow(`${r.stdout.trim()}  `, 'audit_timestamp');
  const backup = fs.readFileSync(path.join(ROOT, 'rootfs/usr/local/bin/cc-hook-backup'), 'utf8');
  assert.match(backup, /lib\/audit-time\.sh/);
  assert.match(backup, /\$\(audit_timestamp\)[^\n]*claude-audit\.log/);
  // No shell writer reads the clock for an audit line itself.
  for (const f of ['cc-hook-audit', 'cc-hook-backup']) {
    const src = fs.readFileSync(path.join(ROOT, 'rootfs/usr/local/bin', f), 'utf8');
    assert.doesNotMatch(src, /date '\+%Y-%m-%d %H:%M:%S'/, `${f} stamps through audit_timestamp`);
  }
});
