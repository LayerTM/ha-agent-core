#!/usr/bin/env node
'use strict';

/*
 * Pins what the install scripts npm is allowed to run actually execute.
 *
 * npm runs a dependency's install scripts only for packages named in the
 * `allowScripts` field of package.json. An entry by name lets every future
 * version run; this check keeps that from being a blank cheque. For each allowed
 * package it fingerprints the installed copy:
 *
 *   - the install-time lifecycle scripts (preinstall, install, postinstall),
 *     or npm's implicit `node-gyp rebuild` when there are none but a
 *     binding.gyp exists;
 *   - every file inside the package those scripts run with `node <file>`, and
 *     every file those require by a relative literal path, transitively;
 *   - every .gyp and .gypi file of the package when node-gyp runs, except the
 *     ones node-gyp generates in build/.
 *
 * and compares the fingerprint with the reviewed one in install-scripts.json next
 * to package.json. A version bump that leaves all of that unchanged passes; any
 * change fails and names what to review. Code a gyp file pulls from another
 * package and the compiled sources are pinned by the lockfile, like every other
 * dependency, not here.
 *
 *   node check-install-scripts.js <dir>           check
 *   node check-install-scripts.js <dir> --write   record the current fingerprints
 *
 * <dir> holds package.json, install-scripts.json and the installed node_modules.
 * Dependency-free. Exit: 0 clean, 1 findings, 2 usage error.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECORD = 'install-scripts.json';
const LIFECYCLE = ['preinstall', 'install', 'postinstall'];
const IMPLICIT_INSTALL = 'node-gyp rebuild';
const NODE_FILE_RE = /(?:^|[\s;&|(])node\s+(?:-{1,2}[\w-]+\s+)*([^\s;&|()'"]+)/g;
const RELATIVE_REQUIRE_RE = /\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const GYP_EXT = new Set(['.gyp', '.gypi']);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Inside the package, or nothing: a script never gets to point the check elsewhere.
function inside(pkgDir, rel) {
  const abs = path.resolve(pkgDir, rel);
  return abs.startsWith(pkgDir + path.sep) ? abs : null;
}

function resolveJs(abs) {
  for (const candidate of [abs, `${abs}.js`, `${abs}.cjs`, path.join(abs, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// node-gyp writes its output, including a generated config.gypi, to build/.
function gypFiles(pkgDir, dir = pkgDir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || (dir === pkgDir && entry.name === 'build')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) gypFiles(pkgDir, abs, out);
    else if (entry.isFile() && GYP_EXT.has(path.extname(entry.name))) out.push(abs);
  }
  return out;
}

function fingerprint(pkgDir) {
  const manifest = readJson(path.join(pkgDir, 'package.json'));
  const scripts = {};
  for (const name of LIFECYCLE) {
    if (typeof manifest.scripts?.[name] === 'string') scripts[name] = manifest.scripts[name];
  }
  if (!scripts.preinstall && !scripts.install && fs.existsSync(path.join(pkgDir, 'binding.gyp'))) {
    scripts.install = IMPLICIT_INSTALL;
  }

  const files = new Set();
  const queue = [];
  for (const command of Object.values(scripts)) {
    for (const match of command.matchAll(NODE_FILE_RE)) {
      const abs = inside(pkgDir, match[1]);
      const file = abs && resolveJs(abs);
      if (file) queue.push(file);
    }
    if (/\bnode-gyp\b/.test(command)) gypFiles(pkgDir).forEach((file) => files.add(file));
  }
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(RELATIVE_REQUIRE_RE)) {
      const abs = inside(pkgDir, path.join(path.dirname(file), match[2]));
      const dep = abs && resolveJs(abs);
      if (dep) queue.push(dep);
    }
  }

  const hashes = {};
  for (const file of [...files].sort()) {
    hashes[path.relative(pkgDir, file).split(path.sep).join('/')] = sha256(file);
  }
  return { version: manifest.version, scripts, files: hashes };
}

// Every installed copy of a package, from the lockfile npm installed from.
function installedCopies(dir, name) {
  const lock = readJson(path.join(dir, 'package-lock.json'));
  return Object.keys(lock.packages || {})
    .filter((key) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .sort()
    .map((key) => path.join(dir, key));
}

function allowedNames(pkg) {
  const problems = [];
  const names = [];
  for (const [key, value] of Object.entries(pkg.allowScripts || {})) {
    if (value !== true) continue;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(key)) {
      problems.push(`allowScripts entry "${key}" is not a bare package name; name the package, the fingerprint pins the version-independent part`);
      continue;
    }
    names.push(key);
  }
  return { names: names.sort(), problems };
}

function current(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const { names, problems } = allowedNames(pkg);
  const packages = {};
  for (const name of names) {
    const copies = installedCopies(dir, name);
    if (copies.length === 0) {
      problems.push(`${name}: allowed in allowScripts but not in package-lock.json`);
      continue;
    }
    for (const copy of copies) {
      if (!fs.existsSync(path.join(copy, 'package.json'))) {
        problems.push(`${name}: ${path.relative(dir, copy)} is not installed`);
        continue;
      }
      const print = fingerprint(copy);
      const previous = packages[name];
      if (previous && JSON.stringify({ ...previous, version: '' }) !== JSON.stringify({ ...print, version: '' })) {
        problems.push(`${name}: installed copies run different install scripts`);
      }
      packages[name] = print;
    }
  }
  return { packages, problems };
}

function compare(recorded, actual) {
  const problems = [];
  for (const name of Object.keys(recorded)) {
    if (!(name in actual)) problems.push(`${name}: recorded in ${RECORD} but not allowed in allowScripts`);
  }
  for (const [name, now] of Object.entries(actual)) {
    const was = recorded[name];
    if (!was) {
      problems.push(`${name}: allowed in allowScripts but not reviewed in ${RECORD}`);
      continue;
    }
    for (const hook of new Set([...Object.keys(was.scripts), ...Object.keys(now.scripts)])) {
      if (was.scripts[hook] !== now.scripts[hook]) {
        problems.push(`${name}@${now.version}: the ${hook} script changed: ${JSON.stringify(was.scripts[hook] ?? null)} -> ${JSON.stringify(now.scripts[hook] ?? null)}`);
      }
    }
    for (const file of new Set([...Object.keys(was.files), ...Object.keys(now.files)])) {
      if (!(file in now.files)) problems.push(`${name}@${now.version}: ${file} is no longer run`);
      else if (!(file in was.files)) problems.push(`${name}@${now.version}: review ${file}, newly run at install`);
      else if (was.files[file] !== now.files[file]) problems.push(`${name}@${now.version}: review ${file}, changed since ${was.version}`);
    }
  }
  return problems;
}

function check(dir) {
  const { packages, problems } = current(dir);
  const recordFile = path.join(dir, RECORD);
  const recorded = fs.existsSync(recordFile) ? readJson(recordFile) : {};
  return { packages, problems: [...problems, ...compare(recorded, packages)] };
}

function write(dir) {
  const { packages, problems } = current(dir);
  if (problems.length === 0) {
    fs.writeFileSync(path.join(dir, RECORD), `${JSON.stringify(packages, null, 2)}\n`);
  }
  return { packages, problems };
}

function main(argv) {
  const args = argv.filter((a) => a !== '--write');
  if (args.length !== 1 || argv.length - args.length > 1 || !fs.existsSync(path.join(args[0], 'package.json'))) {
    process.stderr.write('usage: check-install-scripts.js <dir with package.json> [--write]\n');
    return 2;
  }
  const dir = path.resolve(args[0]);
  const writing = argv.includes('--write');
  const { packages, problems } = writing ? write(dir) : check(dir);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`install scripts: ${problem}\n`);
    if (!writing) {
      process.stderr.write(`After reviewing, record the new state with: node ${path.relative(process.cwd(), __filename)} ${args[0]} --write\n`);
    }
    return 1;
  }
  const names = Object.keys(packages);
  process.stdout.write(`install scripts: ${writing ? 'recorded' : 'as reviewed'} (${names.length ? names.join(', ') : 'none allowed'})\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, write, fingerprint, RECORD };
