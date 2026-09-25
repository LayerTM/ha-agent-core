'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pack = require('../tools/pack.js');
const verify = require('../tools/verify-core.js');
const { git, tempDir, makeRepo, packageJson } = require('./helpers.js');

const PACK = path.join(__dirname, '..', 'tools', 'pack.js');

// One packed file's bytes, read the way a consumer's verifier reads them.
function readEntry(archive, entryPath, lock) {
  const entries = verify.inspectArchive(archive, verify.parseLock(JSON.stringify(lock)));
  const entry = entries.filter((e) => e.path === entryPath)[0];
  assert.ok(entry, `${entryPath} is not in the archive`);
  return entry.data;
}

test('packs exactly the declared files with their modes, plus a manifest', (t) => {
  const repo = makeRepo(t);
  const { archive, lock } = pack.build({ repo });
  const entries = verify.inspectArchive(archive, verify.parseLock(JSON.stringify(lock)));
  assert.deepEqual(entries.map((e) => [e.path, e.mode.toString(8)]), [
    ['ha-agent-core/core-manifest.json', '644'],
    ['ha-agent-core/LICENSE', '644'],
    ['ha-agent-core/app/server/core-version.json', '644'],
    ['ha-agent-core/package-lock.json', '644'],
    ['ha-agent-core/package.json', '644'],
    ['ha-agent-core/src/deep/tool.sh', '755'],
    ['ha-agent-core/src/index.js', '644'],
  ]);
  const manifest = JSON.parse(entries[0].data.toString());
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.commit, git(repo, 'rev-parse', 'HEAD').trim());
  assert.equal(manifest.adapterApi, 1);
  assert.equal(lock.url, 'https://github.com/example/ha-agent-core/releases/download/v1.2.3/ha-agent-core-1.2.3.tar');
});

test('the archive depends on the commit only, not on the clone or the working tree', (t) => {
  const repo = makeRepo(t);
  const first = pack.build({ repo });
  const clone = path.join(tempDir(t), 'clone');
  execFileSync('git', ['clone', '-q', repo, clone]);
  fs.chmodSync(path.join(clone, 'src', 'index.js'), 0o600);
  fs.writeFileSync(path.join(clone, 'src', 'index.js'), 'uncommitted edit\n');
  fs.utimesSync(path.join(clone, 'LICENSE'), 1, 1);
  const second = pack.build({ repo: clone });
  assert.ok(first.archive.equals(second.archive), 'same commit, different bytes');
  assert.equal(first.lock.sha256, second.lock.sha256);
});

test('the archive is an uncompressed ustar stream', (t) => {
  const { archive } = pack.build({ repo: makeRepo(t) });
  assert.equal(archive.length % 512, 0);
  assert.equal(archive.subarray(257, 265).toString('latin1'), 'ustar\x0000');
});

test('every tar timestamp is the commit time and every owner is zero', (t) => {
  const { archive: tar } = pack.build({ repo: makeRepo(t) });
  const epoch = Date.parse('2026-01-02T03:04:05Z') / 1000;
  for (let off = 0; tar[off] !== 0; ) {
    const header = tar.subarray(off, off + 512);
    const field = (o, l) => parseInt(header.subarray(o, o + l).toString().replace(/\0.*$/s, ''), 8);
    assert.equal(field(136, 12), epoch);
    assert.equal(field(108, 8), 0);
    assert.equal(field(116, 8), 0);
    off += 512 + Math.ceil(field(124, 12) / 512) * 512;
  }
});

test('a different commit gives a different archive', (t) => {
  const repo = makeRepo(t);
  const before = pack.build({ repo });
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'module.exports = 2;\n');
  git(repo, 'commit', '-q', '-am', 'change');
  const after = pack.build({ repo });
  assert.notEqual(before.lock.sha256, after.lock.sha256);
  assert.equal(pack.build({ repo, commit: 'HEAD~1' }).lock.sha256, before.lock.sha256);
});

test('refuses a symlink in the packed set', (t) => {
  const repo = makeRepo(t, { 'src/link.js': { link: 'index.js' } });
  assert.throws(() => pack.build({ repo }), /src\/link\.js: blob with mode 120000/);
});

test('refuses a submodule in the packed set', (t) => {
  const repo = makeRepo(t);
  const sub = makeRepo(t);
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'src/vendor');
  git(repo, 'commit', '-q', '-m', 'submodule');
  assert.throws(() => pack.build({ repo }), /src\/vendor: commit with mode 160000/);
});

test('refuses a files entry that matches nothing', (t) => {
  const repo = makeRepo(t, {}, packageJson({ files: ['LICENSE', 'package.json', 'package-lock.json', 'lib/'] }));
  assert.throws(() => pack.build({ repo }), /"lib\/" matches nothing/);
});

test('refuses a files list without the licence, manifest or lock', (t) => {
  const repo = makeRepo(t, {}, packageJson({ files: ['package.json', 'src/'] }));
  assert.throws(() => pack.build({ repo }), /must include LICENSE, package-lock\.json/);
});

test('refuses a file that would shadow the archive manifest', (t) => {
  const repo = makeRepo(t, { 'core-manifest.json': '{}\n' },
    packageJson({ files: ['LICENSE', 'package.json', 'package-lock.json', 'core-manifest.json'] }));
  assert.throws(() => pack.build({ repo }), /reserved for the archive manifest/);
});

test('refuses a file that would shadow the version the archive states', (t) => {
  const repo = makeRepo(t, { 'app/server/core-version.json': '{}\n' },
    packageJson({ files: ['LICENSE', 'package.json', 'package-lock.json', 'app/'] }));
  assert.throws(() => pack.build({ repo }), /reserved for the version the archive states/);
});

// The add-on keeps only `app/` of the core, so the archive's own answer to "which
// core is this?" must be readable from there by the module the add-on runs.
test('the shipped reader, in the shipped layout, reads the packed version and commit', (t) => {
  const reader = fs.readFileSync(path.join(__dirname, '..', 'app', 'server', 'core-version.js'), 'utf8');
  const repo = makeRepo(t, { 'app/server/core-version.js': reader },
    packageJson({ version: '4.5.6', files: ['LICENSE', 'package.json', 'package-lock.json', 'app/'] }));
  const { archive, lock } = pack.build({ repo });
  const app = path.join(tempDir(t), 'agent-console');
  for (const rel of ['server/core-version.js', 'server/core-version.json']) {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), readEntry(archive, `ha-agent-core/app/${rel}`, lock));
  }
  const { readCoreVersion, describeCore } = require(path.join(app, 'server', 'core-version.js'));
  const commit = git(repo, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(readCoreVersion(), { version: '4.5.6', commit });
  assert.equal(describeCore(readCoreVersion()), `core 4.5.6, commit ${commit.slice(0, 12)}`);
});

test('refuses a malformed version, adapter API or repository', (t) => {
  for (const [overrides, message] of [
    [{ version: '1.2' }, /is not X\.Y\.Z/],
    [{ version: '1.2.3-beta.1' }, /is not X\.Y\.Z/],
    [{ haAgentCore: { adapterApi: 0 } }, /adapterApi/],
    [{ haAgentCore: {} }, /adapterApi/],
    [{ repository: { url: 'https://example.com/x.git' } }, /repository\.url/],
    [{ name: 'other' }, /name is "other"/],
  ]) {
    const repo = makeRepo(t, {}, packageJson(overrides));
    assert.throws(() => pack.build({ repo }), message);
  }
});

test('long paths use the ustar prefix, and a path that cannot be split is refused', () => {
  const long = `ha-agent-core/${'d'.repeat(90)}/${'f'.repeat(90)}.js`;
  assert.deepEqual(pack.splitPath(long), { prefix: `ha-agent-core/${'d'.repeat(90)}`, name: `${'f'.repeat(90)}.js` });
  assert.throws(() => pack.splitPath(`ha-agent-core/${'f'.repeat(120)}`), /too long/);
});

test('a long path survives the round trip', (t) => {
  const deep = `src/${'d'.repeat(90)}/${'f'.repeat(90)}.js`;
  const repo = makeRepo(t, { [deep]: 'x\n' });
  const { archive, lock } = pack.build({ repo });
  const entries = verify.inspectArchive(archive, verify.parseLock(JSON.stringify(lock)));
  assert.ok(entries.some((e) => e.path === `ha-agent-core/${deep}`));
});

test('the command line writes the archive, its checksum and the lock, and never overwrites', (t) => {
  const repo = makeRepo(t);
  const out = path.join(tempDir(t), 'dist');
  const first = spawnSync(process.execPath, [PACK, '--out', out], { cwd: repo, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const lock = JSON.parse(fs.readFileSync(path.join(out, 'core.lock.json'), 'utf8'));
  const archive = fs.readFileSync(path.join(out, 'ha-agent-core-1.2.3.tar'));
  assert.equal(verify.sha256(archive), lock.sha256);
  assert.equal(fs.readFileSync(path.join(out, 'ha-agent-core-1.2.3.tar.sha256'), 'utf8'),
    `${lock.sha256}  ha-agent-core-1.2.3.tar\n`);
  assert.equal(first.stdout, `${lock.sha256}  ${path.join(out, 'ha-agent-core-1.2.3.tar')}\n`);

  const again = spawnSync(process.execPath, [PACK, '--out', out], { cwd: repo, encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.ok(fs.readFileSync(path.join(out, 'ha-agent-core-1.2.3.tar')).equals(archive));

  const usage = spawnSync(process.execPath, [PACK], { cwd: repo, encoding: 'utf8' });
  assert.equal(usage.status, 2);
});

test('a packed manifest keeps every script but the ones named as unshipped', (t) => {
  const repo = makeRepo(t, {
    'package.json': packageJson({
      scripts: { start: 'node src/index.js', 'test:usage': 'bash test/usage.test.sh', lint: 'eslint .' },
      haAgentCore: { adapterApi: 1, unshippedScripts: { 'package.json': ['test:usage'] } },
    }),
  });
  const built = pack.build({ repo });
  const packed = JSON.parse(readEntry(built.archive, 'ha-agent-core/package.json', built.lock).toString('utf8'));
  assert.deepEqual(packed.scripts, { start: 'node src/index.js', lint: 'eslint .' },
    'only the named one is left behind; a script this archive cannot judge is kept');
  assert.equal(packed.version, '1.2.3', 'everything else is the manifest as it was');
});

test('a manifest with nothing named is packed byte for byte', (t) => {
  const repo = makeRepo(t, {
    'package.json': packageJson({ scripts: { 'test:usage': 'bash test/usage.test.sh' } }),
  });
  const built = pack.build({ repo });
  const packed = readEntry(built.archive, 'ha-agent-core/package.json', built.lock);
  assert.equal(packed.toString('utf8'), git(repo, 'show', 'HEAD:package.json'),
    'keeping everything means changing nothing, not reformatting it');
});

test('refuses to drop a script the manifest does not have, and to ship a manifest it says nothing about', (t) => {
  const stale = makeRepo(t, {
    'package.json': packageJson({ haAgentCore: { adapterApi: 1, unshippedScripts: { 'package.json': ['test:gone'] } } }),
  });
  assert.throws(() => pack.build({ repo: stale }), /has no script test:gone/);

  const silent = makeRepo(t, {
    'src/package.json': '{"name":"inner","scripts":{"test:usage":"bash test/usage.test.sh"}}\n',
  });
  assert.throws(() => pack.build({ repo: silent }), /says nothing about src\/package\.json/);

  const absent = makeRepo(t, {
    'package.json': packageJson({ haAgentCore: { adapterApi: 1, unshippedScripts: { 'nowhere.json': [] } } }),
  });
  assert.throws(() => pack.build({ repo: absent }), /names nowhere\.json, which is not packed/);

  const malformed = makeRepo(t, {
    'package.json': packageJson({ haAgentCore: { adapterApi: 1, unshippedScripts: ['package.json'] } }),
  });
  assert.throws(() => pack.build({ repo: malformed }), /unshippedScripts is not a map/);
});
