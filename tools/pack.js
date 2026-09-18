#!/usr/bin/env node
'use strict';

/*
 * Builds the release archive of ha-agent-core from one commit.
 *
 * The archive is a function of the commit alone: file contents and modes come from
 * the commit's tree (never from the working tree), entries are sorted, every
 * timestamp is the commit time and owners are zero. It is not compressed: the
 * deflate output of zlib differs between CPU architectures even for one Node.js
 * build, and an archive that is a function of the commit alone can be rebuilt
 * anywhere and compared byte for byte with the published one.
 *
 * What is packed is `files` in the commit's package.json. Only regular files are
 * accepted; a symlink or submodule in that set stops the build. A package
 * manifest is packed without the scripts `haAgentCore.unshippedScripts` names
 * for it, and with every other one. The list says what to DROP, not what to
 * keep, because the archive is not what runs these scripts: a consumer assembles
 * a tree and adds its own tests and configuration, so only a consumer knows
 * which of them still resolve. Keeping by default costs a stale line in a
 * manifest, which is harmless and visible; dropping by default costs a live
 * script in every consumer's CI. The archive gets a
 * manifest (`ha-agent-core/core-manifest.json`) listing version, commit, adapter
 * API and every file's mode, size and SHA-256, and is checked with the consumer's
 * own verifier before anything is written — the packer cannot emit an archive the
 * verifier would refuse.
 *
 * Usage:
 *   pack.js --out DIR [--commit REF]
 * Writes DIR/ha-agent-core-X.Y.Z.tar, DIR/ha-agent-core-X.Y.Z.tar.sha256 and
 * DIR/core.lock.json (the lock a consumer pins). Refuses to overwrite any of them.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const verify = require('./verify-core.js');

const BLOCK = 512;
const REQUIRED_FILES = ['LICENSE', 'package.json', 'package-lock.json'];
const GIT_MODES = { 100644: 0o644, 100755: 0o755 };

/** @param {string} repo @param {string[]} args @param {BufferEncoding | 'buffer'} [encoding] @returns {any} */
function git(repo, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding,
    maxBuffer: verify.LIMITS.archiveBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function octal(value, width) {
  const digits = value.toString(8);
  if (digits.length > width - 1) throw new Error(`${value} does not fit a ${width}-byte tar field`);
  return `${digits.padStart(width - 1, '0')}\0`;
}

// ustar keeps a path in a 100-byte name plus a 155-byte prefix, split at a '/'.
function splitPath(entryPath) {
  if (Buffer.byteLength(entryPath) <= 100) return { name: entryPath, prefix: '' };
  for (let i = entryPath.indexOf('/'); i !== -1; i = entryPath.indexOf('/', i + 1)) {
    const prefix = entryPath.slice(0, i);
    const name = entryPath.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  throw new Error(`${entryPath}: path too long for a ustar archive`);
}

function tarHeader({ name, prefix = '', mode, size, mtime, typeflag = '0', linkname = '' }) {
  const header = Buffer.alloc(BLOCK);
  const put = (text, offset, length) => {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > length) throw new Error(`${JSON.stringify(text)} does not fit a ${length}-byte tar field`);
    bytes.copy(header, offset);
  };
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put('        ', 148, 8);
  put(typeflag, 156, 1);
  put(linkname, 157, 100);
  put('ustar\x0000', 257, 8);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

function tarEntry({ path: entryPath, mode, data, mtime }) {
  const header = tarHeader({ ...splitPath(entryPath), mode, size: data.length, mtime });
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([header, data, padding]);
}

function buildTar(entries, mtime) {
  return Buffer.concat([
    ...entries.map((entry) => tarEntry({ ...entry, mtime })),
    Buffer.alloc(2 * BLOCK),
  ]);
}

function readPackage(repo, commit) {
  const pkg = JSON.parse(git(repo, ['show', `${commit}:package.json`]));
  if (pkg.name !== verify.ROOT) throw new Error(`package.json name is ${JSON.stringify(pkg.name)}, not ${verify.ROOT}`);
  if (typeof pkg.version !== 'string' || !verify.SEMVER.test(pkg.version)) {
    throw new Error(`package.json version ${JSON.stringify(pkg.version)} is not X.Y.Z`);
  }
  const adapterApi = pkg.haAgentCore && pkg.haAgentCore.adapterApi;
  if (!Number.isSafeInteger(adapterApi) || adapterApi < 1) {
    throw new Error('package.json haAgentCore.adapterApi is not a positive integer');
  }
  if (!Array.isArray(pkg.files) || !pkg.files.every((f) => typeof f === 'string' && f)) {
    throw new Error('package.json files is not a list of paths');
  }
  const missing = REQUIRED_FILES.filter((f) => !pkg.files.includes(f));
  if (missing.length) throw new Error(`package.json files must include ${missing.join(', ')}`);
  const repoUrl = /^git\+(https:\/\/github\.com\/[^/]+\/[^/]+?)\.git$/.exec((pkg.repository || {}).url || '');
  if (!repoUrl) throw new Error('package.json repository.url is not git+https://github.com/<owner>/<repo>.git');
  const unshippedScripts = pkg.haAgentCore.unshippedScripts;
  const wellFormed = unshippedScripts && typeof unshippedScripts === 'object' && !Array.isArray(unshippedScripts)
    && Object.values(unshippedScripts).every((names) => Array.isArray(names) && names.every((n) => typeof n === 'string' && n));
  if (!wellFormed) {
    throw new Error('package.json haAgentCore.unshippedScripts is not a map of manifest path to script names');
  }
  return {
    version: pkg.version, adapterApi, files: pkg.files, unshippedScripts, releases: `${repoUrl[1]}/releases/download`,
  };
}

function listFiles(repo, commit, patterns) {
  const found = new Map();
  for (const pattern of patterns) {
    const listing = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', pattern]);
    const records = listing.split('\0').filter(Boolean);
    if (!records.length) throw new Error(`package.json files entry ${JSON.stringify(pattern)} matches nothing in ${commit}`);
    for (const record of records) {
      const [meta, filePath] = [record.slice(0, record.indexOf('\t')), record.slice(record.indexOf('\t') + 1)];
      const [gitMode, type, object] = meta.split(' ');
      if (type !== 'blob' || !Object.hasOwn(GIT_MODES, gitMode)) {
        throw new Error(`${filePath}: ${type} with mode ${gitMode} — only regular files are packed`);
      }
      if (filePath === verify.MANIFEST_NAME) throw new Error(`${filePath}: name reserved for the archive manifest`);
      found.set(filePath, { path: filePath, mode: GIT_MODES[gitMode], object });
    }
  }
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// A manifest as the archive carries it: the same file, without the scripts named
// for it. A name on the list the manifest does not have is an error — a list that
// drops something already gone is out of date and says so here, while it is cheap.
function packedManifest(filePath, data, drop) {
  let manifest;
  try {
    manifest = JSON.parse(data.toString('utf8'));
  } catch (err) {
    throw new Error(`${filePath}: unshippedScripts names it, but it is not JSON (${err.message})`, { cause: err });
  }
  const have = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const absent = drop.filter((name) => !Object.hasOwn(have, name));
  if (absent.length) throw new Error(`${filePath} has no script ${absent.join(', ')}, which unshippedScripts drops`);
  if (!drop.length) return data;
  const scripts = {};
  for (const [name, command] of Object.entries(have)) if (!drop.includes(name)) scripts[name] = command;
  if (Object.keys(scripts).length) manifest.scripts = scripts; else delete manifest.scripts;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function build({ repo, commit = 'HEAD' }) {
  const commitId = git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const mtime = Number(git(repo, ['show', '-s', '--format=%ct', commitId]).trim());
  const pkg = readPackage(repo, commitId);
  const files = listFiles(repo, commitId, pkg.files).map((file) => {
    const data = git(repo, ['cat-file', 'blob', file.object], 'buffer');
    const drop = pkg.unshippedScripts[file.path];
    return { path: file.path, mode: file.mode, data: drop ? packedManifest(file.path, data, drop) : data };
  });
  const unpacked = Object.keys(pkg.unshippedScripts).filter((p) => !files.some((f) => f.path === p));
  if (unpacked.length) throw new Error(`unshippedScripts names ${unpacked.join(', ')}, which is not packed`);
  // Every manifest that ships is decided about — an empty list is a decision and
  // says it out loud. Adding one to `files` without a line here stops the build
  // rather than shipping whatever it happens to declare.
  const undecided = files
    .filter((f) => path.basename(f.path) === 'package.json' && !Object.hasOwn(pkg.unshippedScripts, f.path))
    .map((f) => f.path);
  if (undecided.length) throw new Error(`unshippedScripts says nothing about ${undecided.join(', ')}`);
  const manifest = {
    name: verify.ROOT,
    version: pkg.version,
    commit: commitId,
    adapterApi: pkg.adapterApi,
    files: files.map((f) => ({ path: f.path, mode: f.mode, size: f.data.length, sha256: verify.sha256(f.data) })),
  };
  const entries = [
    { path: `${verify.ROOT}/${verify.MANIFEST_NAME}`, mode: 0o644, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...files.map((f) => ({ ...f, path: `${verify.ROOT}/${f.path}` })),
  ];
  const archive = buildTar(entries, mtime);
  const fileName = verify.archiveName(pkg.version);
  const lock = {
    lockVersion: verify.LOCK_VERSION,
    version: pkg.version,
    commit: commitId,
    url: `${pkg.releases}/v${pkg.version}/${fileName}`,
    sha256: verify.sha256(archive),
    adapterApi: pkg.adapterApi,
  };
  verify.inspectArchive(archive, verify.parseLock(JSON.stringify(lock)));
  return { archive, fileName, lock };
}

function write({ archive, fileName, lock }, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = [
    [fileName, archive],
    [`${fileName}.sha256`, `${lock.sha256}  ${fileName}\n`],
    ['core.lock.json', `${JSON.stringify(lock, null, 2)}\n`],
  ];
  for (const [name] of outputs) {
    if (fs.existsSync(path.join(outDir, name))) throw new Error(`${path.join(outDir, name)} already exists`);
  }
  for (const [name, data] of outputs) fs.writeFileSync(path.join(outDir, name), data, { flag: 'wx' });
  return path.join(outDir, fileName);
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { out: { type: 'string' }, commit: { type: 'string' } },
    }));
    if (!values.out) throw new Error('--out is required');
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: pack.js --out DIR [--commit REF]\n`);
    return 2;
  }
  try {
    const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const result = build({ repo, commit: values.commit });
    const archivePath = write(result, values.out);
    process.stdout.write(`${result.lock.sha256}  ${archivePath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`pack failed: ${err.message}\n`);
    return 1;
  }
}

module.exports = { build, write, buildTar, tarHeader, splitPath, packedManifest };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
