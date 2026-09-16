'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pack = require('../tools/pack.js');
const verify = require('../tools/verify-core.js');
const { tempDir, makeRepo } = require('./helpers.js');

const VERIFY = path.join(__dirname, '..', 'tools', 'verify-core.js');
const COMMIT = 'a'.repeat(40);
const URL_BASE = 'https://github.com/example/ha-agent-core/releases/download';

function lockFor(archive, overrides = {}) {
  return {
    lockVersion: 1,
    version: '1.2.3',
    commit: COMMIT,
    url: `${URL_BASE}/v1.2.3/ha-agent-core-1.2.3.tar`,
    sha256: verify.sha256(archive),
    adapterApi: 1,
    ...overrides,
  };
}

// An archive assembled entry by entry, so that every shape the packer would
// never produce can be tried. Unless `manifest` is given, a correct one is
// generated from the regular entries.
/**
 * @param {Array<Record<string, any>>} entries
 * @param {{ manifest?: string, manifestExtra?: Record<string, any>, trailer?: Buffer, blocksAfter?: number }} [options]
 */
function craft(entries, { manifest, manifestExtra = {}, trailer, blocksAfter = 2 } = {}) {
  const regular = entries.filter((e) => (e.typeflag || '0') === '0');
  const body = manifest !== undefined ? manifest : {
    name: 'ha-agent-core',
    version: '1.2.3',
    commit: COMMIT,
    adapterApi: 1,
    files: regular.map((e) => ({
      path: e.path.replace(/^ha-agent-core\//, ''),
      mode: e.mode || 0o644,
      size: Buffer.from(e.data || '').length,
      sha256: verify.sha256(Buffer.from(e.data || '')),
    })),
    ...manifestExtra,
  };
  const all = [
    { path: 'ha-agent-core/core-manifest.json', data: typeof body === 'string' ? body : JSON.stringify(body) },
    ...entries,
  ];
  const blocks = all.map((e) => {
    const data = Buffer.from(e.data || '');
    const header = pack.tarHeader({
      ...(Buffer.byteLength(e.path) > 100 ? pack.splitPath(e.path) : { name: e.path }),
      mode: e.mode || 0o644,
      size: data.length,
      mtime: 0,
      typeflag: e.typeflag,
      linkname: e.linkname,
    });
    if (e.mutateHeader) e.mutateHeader(header);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  });
  return Buffer.concat([...blocks, Buffer.alloc(512 * blocksAfter), trailer || Buffer.alloc(0)]);
}

const GOOD = [
  { path: 'ha-agent-core/package.json', data: '{}\n' },
  { path: 'ha-agent-core/bin/run.sh', data: '#!/bin/sh\n', mode: 0o755 },
];

function inspect(archive, overrides) {
  return verify.inspectArchive(archive, verify.parseLock(JSON.stringify(lockFor(archive, overrides))));
}

function refused(fn, pattern) {
  assert.throws(fn, (err) => err instanceof verify.Refusal && pattern.test(err.message));
}

// --- the lock -------------------------------------------------------------

test('a well-formed lock is accepted', () => {
  const lock = verify.parseLock(JSON.stringify(lockFor(Buffer.from('x'))));
  assert.equal(lock.version, '1.2.3');
  assert.ok(Object.isFrozen(lock));
});

test('a lock with a missing, unknown or malformed field is refused', () => {
  const base = lockFor(Buffer.from('x'));
  const cases = [
    [{ ...base, sha256: undefined }, /missing: sha256/],
    [{ ...base, extra: 1 }, /unknown keys: extra/],
    [{ ...base, lockVersion: 2 }, /lockVersion/],
    [{ ...base, version: '1.2' }, /release version/],
    [{ ...base, version: '01.2.3' }, /release version/],
    [{ ...base, version: '1.2.3-rc.1' }, /release version/],
    [{ ...base, commit: 'A'.repeat(40) }, /commit/],
    [{ ...base, commit: 'a'.repeat(7) }, /commit/],
    [{ ...base, sha256: 'F'.repeat(64) }, /sha256/],
    [{ ...base, sha256: 'f'.repeat(63) }, /sha256/],
    [{ ...base, adapterApi: 0 }, /adapterApi/],
    [{ ...base, adapterApi: '1' }, /adapterApi/],
    [{ ...base, adapterApi: 1.5 }, /adapterApi/],
    [{ ...base, url: base.url.replace('https:', 'http:') }, /not https/],
    [{ ...base, url: `${base.url}?x=1` }, /query or fragment/],
    [{ ...base, url: `${base.url}#x` }, /query or fragment/],
    [{ ...base, url: base.url.replace('https://', 'https://user:pw@') }, /credentials/],
    [{ ...base, url: base.url.replace('v1.2.3/', 'v1.2.4/') }, /does not end in/],
    [{ ...base, url: base.url.replace('1.2.3.tar', '1.2.4.tar') }, /does not end in/],
    [{ ...base, url: base.url.replace('/releases/download', '/raw') }, /does not end in/],
    [{ ...base, url: base.url.replace('releases', 'x/../releases') }, /canonical/],
    [{ ...base, url: 'https:/releases/download/v1.2.3/ha-agent-core-1.2.3.tar' }, /canonical|does not end in/],
    [{ ...base, url: 7 }, /not a string/],
  ];
  for (const [lock, pattern] of cases) {
    refused(() => verify.parseLock(JSON.stringify(lock)), pattern);
  }
  refused(() => verify.parseLock('{'), /not valid JSON/);
  refused(() => verify.parseLock('[]'), /not a JSON object/);
  refused(() => verify.parseLock('null'), /not a JSON object/);
});

test('a lock may move to a new version but never re-point a pinned one', () => {
  const previous = verify.parseLock(JSON.stringify(lockFor(Buffer.from('old'))));
  verify.checkTransition(previous, previous);
  const next = verify.parseLock(JSON.stringify(lockFor(Buffer.from('new'), {
    version: '1.2.4', url: `${URL_BASE}/v1.2.4/ha-agent-core-1.2.4.tar`,
  })));
  verify.checkTransition(previous, next);
  for (const change of [
    { sha256: 'b'.repeat(64) },
    { commit: 'b'.repeat(40) },
    { adapterApi: 2 },
    { url: previous.url.replace('example', 'elsewhere') },
  ]) {
    const replaced = verify.parseLock(JSON.stringify({ ...previous, ...change }));
    refused(() => verify.checkTransition(previous, replaced), /already pinned/);
  }
});

test('an adapter API other than the pinned one is refused', () => {
  const lock = verify.parseLock(JSON.stringify(lockFor(Buffer.from('x'))));
  verify.checkAdapterApi(lock, 1);
  refused(() => verify.checkAdapterApi(lock, 2), /pins adapter API 1, this consumer speaks 2/);
  refused(() => verify.checkAdapterApi(lock, undefined), /not a positive integer/);
});

// --- the archive ----------------------------------------------------------

test('a well-formed archive is accepted', () => {
  const entries = inspect(craft(GOOD));
  assert.deepEqual(entries.map((e) => e.path), [
    'ha-agent-core/core-manifest.json', 'ha-agent-core/package.json', 'ha-agent-core/bin/run.sh',
  ]);
});

test('a digest mismatch is refused before the archive is opened', () => {
  const archive = craft(GOOD);
  refused(() => inspect(archive, { sha256: 'b'.repeat(64) }), /digest mismatch/);
  const flipped = Buffer.from(archive);
  flipped[flipped.length - 9] ^= 1;
  refused(() => verify.inspectArchive(flipped, verify.parseLock(JSON.stringify(lockFor(archive)))), /digest mismatch/);
});

test('data that is not a tar stream is refused', () => {
  refused(() => inspect(Buffer.from('not a tar stream')), /whole number/);
  refused(() => inspect(Buffer.alloc(512, 0x41)), /malformed number/);
});

test('escaping, absolute and unusual paths are refused', () => {
  for (const [entryPath, pattern] of [
    ['ha-agent-core/../evil', /'\.\.'/],
    ['ha-agent-core/a/../../evil', /'\.\.'/],
    ['../evil', /outside the ha-agent-core\/ root/],
    ['/etc/passwd', /outside/],
    ['ha-agent-core', /outside/],
    ['other/file', /outside/],
    ['ha-agent-core//file', /empty/],
    ['ha-agent-core/./file', /'\.'/],
    ['ha-agent-core/dir/', /empty/],
    ['ha-agent-core/a\\..\\b', /forbidden character/],
    ['ha-agent-core/a\nb', /forbidden character/],
    ['ha-agent-core/café', /NFC/],
  ]) {
    refused(() => inspect(craft([{ path: entryPath, data: 'x' }])), pattern);
  }
});

test('links, directories and every other special entry are refused', () => {
  /** @type {Array<[string, Record<string, string>]>} */
  const specials = [
    ['2', { linkname: '/etc/passwd' }],
    ['1', { linkname: 'ha-agent-core/package.json' }],
    ['5', {}],
    ['3', {}], ['4', {}], ['6', {}], ['7', {}],
    ['x', {}], ['g', {}], ['L', {}], ['K', {}],
  ];
  for (const [typeflag, extra] of specials) {
    const archive = craft([...GOOD, { path: 'ha-agent-core/special', typeflag, ...extra }]);
    refused(() => inspect(archive), /only regular files/);
  }
});

test('a regular file carrying a link name is refused', () => {
  refused(() => inspect(craft([{ path: 'ha-agent-core/f', data: 'x', linkname: '/etc/passwd' }])), /link name/);
});

test('a file mode other than 644 or 755 is refused', () => {
  for (const mode of [0o4755, 0o2755, 0o777, 0o600, 0o1644]) {
    refused(() => inspect(craft([{ path: 'ha-agent-core/f', data: 'x', mode }])), /neither 644 nor 755/);
  }
});

test('duplicates, case collisions and file/directory collisions are refused', () => {
  for (const entries of [
    [{ path: 'ha-agent-core/a', data: '1' }, { path: 'ha-agent-core/a', data: '2' }],
    [{ path: 'ha-agent-core/Readme', data: '1' }, { path: 'ha-agent-core/README', data: '2' }],
    [{ path: 'ha-agent-core/lib', data: '1' }, { path: 'ha-agent-core/lib/x', data: '2' }],
    [{ path: 'ha-agent-core/lib/x', data: '2' }, { path: 'ha-agent-core/lib', data: '1' }],
    [{ path: 'ha-agent-core/Lib/x', data: '1' }, { path: 'ha-agent-core/lib/y', data: '2' }],
    [{ path: 'ha-agent-core/core-manifest.json', data: '{}' }],
  ]) {
    refused(() => inspect(craft(entries, { manifest: '{}' })), /collides/);
  }
});

test('a damaged header, truncated body or stray data is refused', () => {
  const bad = (mutate) => [{ path: 'ha-agent-core/f', data: 'x', mutateHeader: mutate }];
  refused(() => inspect(craft(bad((h) => { h[0] ^= 1; }))), /checksum mismatch/);
  refused(() => inspect(craft(bad((h) => { h.write('gnutar', 257); }))), /checksum mismatch|not a ustar/);
  const tar = craft(GOOD);
  refused(() => inspect(tar.subarray(0, tar.length - 1)), /whole number/);
  refused(() => inspect(tar.subarray(0, 1024)), /truncated|end-of-archive/);
  refused(() => inspect(tar.subarray(0, tar.length - 1024)), /end-of-archive/);
  refused(() => inspect(tar.subarray(0, tar.length - 512)), /inside the end-of-archive/);
  const trailer = Buffer.alloc(512);
  trailer[5] = 1;
  refused(() => inspect(craft(GOOD, { trailer })), /after the end-of-archive/);
  refused(() => inspect(craft(bad((h) => { h.write('9999999999999', 124, 'latin1'); }))), /malformed number|checksum/);
});

test('a size field that points past the end is refused', () => {
  const archive = craft([{
    path: 'ha-agent-core/f',
    data: 'x',
    mutateHeader(h) {
      h.write('00000077777\0', 124, 'latin1');
      h.write('        ', 148, 'latin1');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    },
  }]);
  refused(() => inspect(archive), /truncated/);
});

test('non-zero padding after a file is refused', () => {
  const tar = craft(GOOD);
  const manifestSize = parseInt(tar.subarray(124, 135).toString(), 8);
  tar[512 + manifestSize] = 0x41;
  refused(() => inspect(tar), /non-zero padding/);
});

test('an archive past the size limit is refused before it is hashed', () => {
  const huge = Buffer.alloc(verify.LIMITS.archiveBytes + 512);
  refused(() => verify.inspectArchive(huge, verify.parseLock(JSON.stringify(lockFor(Buffer.from('x'))))), /size limit/);
});

test('a missing, malformed or disagreeing manifest is refused', () => {
  const noManifest = (() => {
    const header = pack.tarHeader({ name: 'ha-agent-core/f', mode: 0o644, size: 1, mtime: 0 });
    return Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511 + 1024)]);
  })();
  refused(() => inspect(noManifest), /no ha-agent-core\/core-manifest\.json/);
  refused(() => inspect(craft(GOOD, { manifest: 'not json' })), /manifest is not valid JSON/);
  refused(() => inspect(craft(GOOD, { manifestExtra: { extra: true } })), /unknown keys: extra/);
  refused(() => inspect(craft(GOOD, { manifestExtra: { name: 'other' } })), /manifest\.name/);
  refused(() => inspect(craft(GOOD, { manifestExtra: { version: '1.2.4' } })), /manifest\.version/);
  refused(() => inspect(craft(GOOD, { manifestExtra: { commit: 'b'.repeat(40) } })), /manifest\.commit/);
  refused(() => inspect(craft(GOOD, { manifestExtra: { adapterApi: 2 } })), /manifest\.adapterApi/);
  refused(() => inspect(craft(GOOD, { manifestExtra: { files: 'x' } })), /not a list/);

  const listed = (edit) => {
    const files = GOOD.map((e) => ({
      path: e.path.slice('ha-agent-core/'.length),
      mode: e.mode || 0o644,
      size: Buffer.byteLength(e.data),
      sha256: verify.sha256(Buffer.from(e.data)),
    }));
    return craft(GOOD, { manifestExtra: { files: edit(files) } });
  };
  refused(() => inspect(listed((f) => f.slice(1))), /lists 1 files, the archive holds 2/);
  refused(() => inspect(listed((f) => [...f, { ...f[0], path: 'ghost' }])), /lists 3 files/);
  refused(() => inspect(listed((f) => [f[0], f[0]])), /does not match the archive/);
  refused(() => inspect(listed((f) => [{ ...f[0], path: 'ghost' }, f[1]])), /does not match the archive/);
  refused(() => inspect(listed((f) => [{ ...f[0], sha256: 'b'.repeat(64) }, f[1]])), /differs from the manifest/);
  refused(() => inspect(listed((f) => [{ ...f[0], size: 99 }, f[1]])), /differs from the manifest/);
  refused(() => inspect(listed((f) => [{ ...f[0], mode: 0o755 }, f[1]])), /differs from the manifest/);
  refused(() => inspect(listed((f) => [{ ...f[0], extra: 1 }, f[1]])), /unknown keys/);
});

// --- installation and the command line --------------------------------------

function fixture(t, archive, lockOverrides) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'archive.tar'), archive);
  fs.writeFileSync(path.join(dir, 'core.lock.json'), JSON.stringify(lockFor(archive, lockOverrides)));
  return dir;
}

function cli(...args) {
  return spawnSync(process.execPath, [VERIFY, ...args], { encoding: 'utf8' });
}

function installArgs(dir, dest = path.join(dir, 'core'), extra = []) {
  return ['install', '--lock', path.join(dir, 'core.lock.json'), '--archive', path.join(dir, 'archive.tar'),
    '--dest', dest, '--adapter-api', '1', ...extra];
}

test('install writes exactly the verified tree with its modes', (t) => {
  const dir = fixture(t, craft(GOOD));
  const result = cli(...installArgs(dir));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed ha-agent-core 1\.2\.3 \(3 files\)/);
  const core = path.join(dir, 'core');
  assert.equal(fs.readFileSync(path.join(core, 'package.json'), 'utf8'), '{}\n');
  assert.equal(fs.statSync(path.join(core, 'bin', 'run.sh')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(core, 'package.json')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(core).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(core, 'bin')).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['archive.tar', 'core', 'core.lock.json']);
});

test('install refuses an existing destination and leaves it untouched', (t) => {
  const dir = fixture(t, craft(GOOD));
  const core = path.join(dir, 'core');
  fs.mkdirSync(core);
  fs.writeFileSync(path.join(core, 'package.json'), 'previous\n');
  const result = cli(...installArgs(dir));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.deepEqual(fs.readdirSync(core), ['package.json']);
  assert.equal(fs.readFileSync(path.join(core, 'package.json'), 'utf8'), 'previous\n');

  fs.rmSync(core, { recursive: true });
  fs.symlinkSync(dir, core);
  assert.equal(cli(...installArgs(dir)).status, 1, 'a dangling or live symlink is an existing destination');
});

test('an empty directory at the destination is refused too', (t) => {
  const dir = fixture(t, craft(GOOD));
  fs.mkdirSync(path.join(dir, 'core'));
  const result = cli(...installArgs(dir));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'core')), []);
});

// Runs install in-process with one fs function wrapped, to act inside the
// window between the destination check and the final rename.
function installWith(t, name, wrapper) {
  const dir = fixture(t, craft(GOOD));
  const original = fs[name];
  fs[name] = wrapper(original, path.join(dir, 'core'));
  t.after(() => { fs[name] = original; });
  const run = () => verify.install({
    lock: path.join(dir, 'core.lock.json'),
    archive: path.join(dir, 'archive.tar'),
    dest: path.join(dir, 'core'),
    adapterApi: 1,
    previousLock: undefined,
  });
  return { dir, run, restore: () => { fs[name] = original; } };
}

test('a destination cannot be created by someone else once installation has begun', (t) => {
  let raced;
  const { dir, run, restore } = installWith(t, 'mkdtempSync', (original, target) => (...args) => {
    try {
      fs.mkdirSync(target);
      raced = 'created';
    } catch (err) {
      raced = err.code;
    }
    return original(...args);
  });
  const result = run();
  restore();
  assert.equal(raced, 'EEXIST');
  assert.equal(result.files, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'core', 'package.json'), 'utf8'), '{}\n');
});

test('content placed at the destination during installation is never replaced', (t) => {
  const { dir, run, restore } = installWith(t, 'renameSync', (original, target) => (from, to) => {
    if (to === target) {
      fs.rmdirSync(target);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'theirs'), 'kept\n');
    }
    return original(from, to);
  });
  refused(run, /filled by someone else/);
  restore();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'core')), ['theirs']);
  assert.equal(fs.readFileSync(path.join(dir, 'core', 'theirs'), 'utf8'), 'kept\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['archive.tar', 'core', 'core.lock.json']);
});

test('a failure while writing removes the claim and the staging directory', (t) => {
  const { dir, run, restore } = installWith(t, 'writeFileSync', (original) => (file, ...rest) => {
    if (String(file).includes('staging')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return original(file, ...rest);
  });
  assert.throws(run, /disk full/);
  restore();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['archive.tar', 'core.lock.json']);
});

test('a refused install writes nothing at all', (t) => {
  const archive = craft([...GOOD, { path: 'ha-agent-core/../escape', data: 'x' }]);
  const dir = fixture(t, archive);
  const result = cli(...installArgs(dir));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^refused: /);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['archive.tar', 'core.lock.json']);
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape')));
});

test('install refuses a replaced archive, a re-pointed version and a foreign adapter API', (t) => {
  const dir = fixture(t, craft(GOOD));
  fs.writeFileSync(path.join(dir, 'archive.tar'), craft([{ path: 'ha-agent-core/other', data: 'y' }]));
  let result = cli(...installArgs(dir));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /digest mismatch/);

  const repointed = fixture(t, craft(GOOD));
  const previous = path.join(repointed, 'previous.lock.json');
  fs.writeFileSync(previous, JSON.stringify(lockFor(Buffer.from('the archive first published'))));
  result = cli(...installArgs(repointed, undefined, ['--previous-lock', previous]));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already pinned; this lock changes sha256/);

  result = cli(...installArgs(repointed).slice(0, -1), '2');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /this consumer speaks 2/);
  assert.ok(!fs.existsSync(path.join(repointed, 'core')));
});

test('check and url read only the lock', (t) => {
  const dir = fixture(t, craft(GOOD));
  const lock = path.join(dir, 'core.lock.json');
  let result = cli('check', '--lock', lock, '--adapter-api', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'lock verified: ha-agent-core 1.2.3\n');
  result = cli('url', '--lock', lock);
  assert.equal(result.stdout, `${URL_BASE}/v1.2.3/ha-agent-core-1.2.3.tar\n`);

  const previous = path.join(dir, 'previous.lock.json');
  fs.writeFileSync(previous, JSON.stringify(lockFor(Buffer.from('other'))));
  result = cli('check', '--lock', lock, '--adapter-api', '1', '--previous-lock', previous);
  assert.equal(result.status, 1);

  fs.writeFileSync(lock, '{"lockVersion": 1}');
  result = cli('url', '--lock', lock);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(cli('url', '--lock', path.join(dir, 'missing.json')).status, 1);
});

test('usage errors exit 2 and do nothing', (t) => {
  const dir = fixture(t, craft(GOOD));
  for (const args of [
    [],
    ['unpack'],
    ['install', '--lock', path.join(dir, 'core.lock.json')],
    ['check', '--lock', path.join(dir, 'core.lock.json')],
    ['check', '--lock', path.join(dir, 'core.lock.json'), '--adapter-api', '01'],
    ['check', '--lock', path.join(dir, 'core.lock.json'), '--adapter-api', 'one'],
    ['url', '--lock', path.join(dir, 'core.lock.json'), '--dest', dir],
    ['url', '--lock', path.join(dir, 'core.lock.json'), 'positional'],
    ['url', '--lock', path.join(dir, 'core.lock.json'), '--unknown'],
    [...installArgs(dir), '--unknown', 'x'],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /usage:/);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'core')));
});

test('an archive built by the packer installs end to end', (t) => {
  const repo = makeRepo(t);
  const out = path.join(tempDir(t), 'dist');
  pack.write(pack.build({ repo }), out);
  const dest = path.join(out, 'installed');
  const result = cli('install', '--lock', path.join(out, 'core.lock.json'),
    '--archive', path.join(out, 'ha-agent-core-1.2.3.tar'), '--dest', dest, '--adapter-api', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dest, 'src', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.statSync(path.join(dest, 'src', 'deep', 'tool.sh')).mode & 0o777, 0o755);
  assert.ok(!fs.existsSync(path.join(dest, 'test')));
});

// --- assembly ------------------------------------------------------------------

function assemblyFixture(t, consumerFilesToWrite) {
  const dir = tempDir(t);
  const core = path.join(dir, 'core');
  fs.mkdirSync(core);
  fs.writeFileSync(path.join(core, 'core-manifest.json'), JSON.stringify({
    name: 'ha-agent-core', version: '1.2.3', commit: COMMIT, adapterApi: 1,
    files: ['app/server/index.js', 'app/package.json', 'rootfs/usr/local/bin/ha-state', 'LICENSE']
      .map((p) => ({ path: p, mode: 0o644, size: 0, sha256: verify.sha256(Buffer.alloc(0)) })),
  }));
  const consumer = path.join(dir, 'addon');
  for (const rel of consumerFilesToWrite) {
    fs.mkdirSync(path.dirname(path.join(consumer, rel)), { recursive: true });
    fs.writeFileSync(path.join(consumer, rel), 'x');
  }
  fs.mkdirSync(consumer, { recursive: true });
  return { core, consumer };
}

test('an add-on that adds only its own paths assembles', (t) => {
  const { core, consumer } = assemblyFixture(t, [
    'app/adapter/index.js', 'app/public/index.html', 'rootfs/usr/local/bin/start-agent', 'Dockerfile', 'LICENSE',
  ]);
  const result = cli('check-assembly', '--core', core, '--consumer', consumer);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'assembly verified: 3 add-on files, 4 files of ha-agent-core 1.2.3\n');
  // Files outside the assembled roots are the add-on's business.
  assert.equal(verify.checkAssembly({ core, consumer }).consumerFiles, 3);
});

test('an add-on path that the core also ships is refused', (t) => {
  for (const clash of ['app/package.json', 'rootfs/usr/local/bin/ha-state', 'rootfs/usr/local/bin/HA-State', 'app/server/index.js']) {
    const { core, consumer } = assemblyFixture(t, ['app/adapter/index.js', clash]);
    refused(() => verify.checkAssembly({ core, consumer }), /overlap/);
    const result = cli('check-assembly', '--core', core, '--consumer', consumer);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${clash.replace(/[.]/g, '\\.')} is also a core file`));
  }
});

test('an add-on file inside a directory the core owns is refused', (t) => {
  const { core, consumer } = assemblyFixture(t, ['app/server/extra.js', 'app/server/prompt/runner.js']);
  refused(() => verify.checkAssembly({ core, consumer }),
    /app\/server\/extra\.js is at or inside app\/server,[\s\S]*app\/server\/prompt\/runner\.js is at or inside app\/server,/);
});

test('files, links and directories that collide with the core\'s shape are refused', (t) => {
  // Each case builds its own add-on tree next to the same installed core.
  /** @type {Array<[string, (dir: string) => void, RegExp]>} */
  const cases = [
    ['a file at a directory the core owns', (c) => {
      fs.mkdirSync(path.join(c, 'app'), { recursive: true });
      fs.writeFileSync(path.join(c, 'app', 'server'), 'x');
    }, /app\/server is also|app\/server is a file where the core has a directory[\s\S]*app\/server is at or inside app\/server/],
    ['an empty directory the core owns', (c) => {
      fs.mkdirSync(path.join(c, 'app', 'server'), { recursive: true });
    }, /app\/server is at or inside app\/server/],
    ['a link at a directory the core owns', (c) => {
      fs.mkdirSync(path.join(c, 'app'), { recursive: true });
      fs.symlinkSync('/tmp', path.join(c, 'app', 'server'));
    }, /app\/server is a link where the core has a directory/],
    ['a file where the core has a directory', (c) => {
      fs.mkdirSync(path.join(c, 'rootfs', 'usr', 'local'), { recursive: true });
      fs.writeFileSync(path.join(c, 'rootfs', 'usr', 'local', 'bin'), 'x');
    }, /rootfs\/usr\/local\/bin is a file where the core has a directory/],
    ['a link where the core has a directory', (c) => {
      fs.mkdirSync(path.join(c, 'rootfs', 'usr'), { recursive: true });
      fs.symlinkSync('/usr/local', path.join(c, 'rootfs', 'usr', 'local'));
    }, /rootfs\/usr\/local is a link where the core has a directory/],
    ['a directory where the core has a file', (c) => {
      fs.mkdirSync(path.join(c, 'rootfs', 'usr', 'local', 'bin', 'ha-state'), { recursive: true });
    }, /rootfs\/usr\/local\/bin\/ha-state is a directory where the core has a file/],
    ['a whole root that is not a directory', (c) => {
      fs.symlinkSync('/', path.join(c, 'rootfs'));
    }, /rootfs is a link where the core has a directory/],
  ];
  for (const [name, build, pattern] of cases) {
    const { core, consumer } = assemblyFixture(t, []);
    build(consumer);
    assert.throws(() => verify.checkAssembly({ core, consumer }),
      (err) => err instanceof verify.Refusal && pattern.test(err.message), name);
  }
});

test('a link in the add-on tree is a path like any other', (t) => {
  const { core, consumer } = assemblyFixture(t, ['app/adapter/index.js']);
  fs.symlinkSync('/etc/hostname', path.join(consumer, 'app', 'package.json'));
  refused(() => verify.checkAssembly({ core, consumer }), /app\/package\.json is also a core file/);
});

test('a missing or foreign manifest, or a missing add-on tree, is refused', (t) => {
  const { core, consumer } = assemblyFixture(t, []);
  refused(() => verify.checkAssembly({ core: path.join(core, 'nope'), consumer }), /installed manifest cannot be read/);
  refused(() => verify.checkAssembly({ core, consumer: path.join(consumer, 'nope') }), /cannot be read/);
  fs.writeFileSync(path.join(core, 'core-manifest.json'), '{"name":"other"}');
  refused(() => verify.checkAssembly({ core, consumer }), /installed manifest is missing/);
  assert.equal(cli('check-assembly', '--core', core).status, 2);
  assert.equal(cli('check-assembly', '--core', core, '--consumer', consumer, '--lock', 'x').status, 2);
  assert.equal(cli('url', '--lock', 'x', '--previous-lock', 'y').status, 2);
});
