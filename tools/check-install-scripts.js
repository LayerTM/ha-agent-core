#!/usr/bin/env node
'use strict';

/*
 * Verifies, before any of it runs, the code an allowed install script will run.
 *
 * npm runs a dependency's install scripts only for packages named in the
 * `allowScripts` field of package.json. An entry by name lets every future
 * version run, so this check pins what that means. Run it after
 * `npm ci --ignore-scripts` (nothing of the packages has executed yet) and build
 * only when it passes. For each allowed package it fingerprints:
 *
 *   - the install-time lifecycle scripts (preinstall, install, postinstall),
 *     or npm's implicit `node-gyp rebuild` when there are none but a
 *     binding.gyp exists;
 *   - every file those scripts run with `node <file>`;
 *   - every .gyp and .gypi file of the package when node-gyp runs, and every
 *     file those name with `node <file>`;
 *   - every module any of these files loads with require(), transitively:
 *     relative files, and other installed packages (their entry module and
 *     everything it loads, plus their .gyp/.gypi files, which a gyp build may
 *     include) — node-pty's binding.gyp, for one, runs require('node-addon-api').
 *
 * and compares the fingerprint with the reviewed one in install-scripts.json next
 * to package.json. Any difference is reported with the file to review. A module
 * the scan cannot resolve is part of the fingerprint too, by name.
 *
 *   node check-install-scripts.js <dir>                  check
 *   node check-install-scripts.js <dir> --write          record the current fingerprints
 *   node check-install-scripts.js <dir> --verdict FILE   check, and also write
 *                                                        {"reviewed": bool, "findings": [...]}
 *
 * <dir> holds package.json, install-scripts.json and the installed node_modules.
 * Dependency-free. Exit: 0 as reviewed, 1 findings, 2 usage error.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECORD = 'install-scripts.json';
const LIFECYCLE = ['preinstall', 'install', 'postinstall'];
const IMPLICIT_INSTALL = 'node-gyp rebuild';
const NODE_FILE_RE = /(?:^|[\s;&|(])node\s+(?:-{1,2}[\w-]+\s+)*([^\s;&|()'"\\]+)/g;
// require('x'), also inside a quoted gyp command: require(\'x\')
const REQUIRE_RE = /\brequire\s*\(\s*\\?(['"])([^'"\\]+)\\?\1\s*\)/g;
const GYP_EXT = new Set(['.gyp', '.gypi']);
const BUILTINS = new Set(require('node:module').builtinModules);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function within(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}

function resolveFile(abs) {
  for (const candidate of [abs, `${abs}.js`, `${abs}.cjs`, `${abs}.json`, path.join(abs, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// node-gyp writes its output, including a generated config.gypi, to build/.
function gypFiles(pkgRoot, dir = pkgRoot, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || (dir === pkgRoot && entry.name === 'build')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) gypFiles(pkgRoot, abs, out);
    else if (entry.isFile() && GYP_EXT.has(path.extname(entry.name))) out.push(abs);
  }
  return out.sort();
}

// The installed package a bare specifier names, looked up the way node does,
// never above the project.
function packageRoot(project, fromDir, name) {
  for (let dir = fromDir; within(project, dir); dir = path.dirname(dir)) {
    const root = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(root, 'package.json'))) return root;
    if (dir === project) break;
  }
  return null;
}

function fingerprint(project, pkgRoot) {
  const manifest = readJson(path.join(pkgRoot, 'package.json'));
  const scripts = {};
  for (const name of LIFECYCLE) {
    if (typeof manifest.scripts?.[name] === 'string') scripts[name] = manifest.scripts[name];
  }
  if (!scripts.preinstall && !scripts.install && fs.existsSync(path.join(pkgRoot, 'binding.gyp'))) {
    scripts.install = IMPLICIT_INSTALL;
  }

  const files = new Map(); // absolute path -> key
  const unresolved = new Set();
  const packages = new Set();
  const nodeModules = path.join(project, 'node_modules') + path.sep;
  const keyOf = (abs) => (within(pkgRoot, abs)
    ? path.relative(pkgRoot, abs)
    : `node_modules/${path.relative(nodeModules, abs)}`).split(path.sep).join('/');

  // A file that runs, or is read by what runs: record it and follow what it loads.
  const visit = (abs) => {
    if (!abs || !within(project, abs) || files.has(abs)) return;
    files.set(abs, keyOf(abs));
    const ext = path.extname(abs);
    if (ext === '.json') return;
    const text = fs.readFileSync(abs, 'utf8');
    if (GYP_EXT.has(ext)) {
      // node-gyp runs a gyp file's commands in that file's directory.
      for (const match of text.matchAll(NODE_FILE_RE)) visit(resolveFile(path.resolve(path.dirname(abs), match[1])));
    }
    for (const match of text.matchAll(REQUIRE_RE)) {
      const spec = match[2];
      if (spec.startsWith('.')) {
        visit(resolveFile(path.resolve(path.dirname(abs), spec)));
        continue;
      }
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (spec.startsWith('node:') || BUILTINS.has(name)) continue;
      const root = packageRoot(project, path.dirname(abs), name);
      if (!root) { unresolved.add(spec); continue; }
      const sub = parts.slice(name.startsWith('@') ? 2 : 1).join('/');
      if (sub) {
        visit(resolveFile(path.join(root, sub)));
      } else {
        const entry = readJson(path.join(root, 'package.json')).main || 'index.js';
        visit(resolveFile(path.join(root, entry)));
      }
      if (!packages.has(root)) {
        packages.add(root);
        gypFiles(root).forEach(visit);
      }
    }
  };

  for (const command of Object.values(scripts)) {
    for (const match of command.matchAll(NODE_FILE_RE)) {
      const abs = path.resolve(pkgRoot, match[1]);
      if (within(pkgRoot, abs)) visit(resolveFile(abs));
    }
    if (/\bnode-gyp\b/.test(command)) gypFiles(pkgRoot).forEach(visit);
  }

  const hashes = {};
  for (const [abs, key] of [...files].sort((a, b) => a[1].localeCompare(b[1]))) hashes[key] = sha256(abs);
  for (const spec of [...unresolved].sort()) hashes[`unresolved:${spec}`] = 'unresolved';
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
      const print = fingerprint(dir, copy);
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
  const args = [...argv];
  const writing = args.includes('--write');
  let verdictFile = null;
  const at = args.indexOf('--verdict');
  if (at !== -1) {
    verdictFile = args[at + 1];
    args.splice(at, 2);
  }
  const dirs = args.filter((a) => a !== '--write');
  if (dirs.length !== 1 || args.length - dirs.length > 1 || (writing && at !== -1) || (at !== -1 && !verdictFile)
      || !fs.existsSync(path.join(dirs[0], 'package.json'))) {
    process.stderr.write('usage: check-install-scripts.js <dir with package.json> [--write | --verdict FILE]\n');
    return 2;
  }
  const dir = path.resolve(dirs[0]);
  const { packages, problems } = writing ? write(dir) : check(dir);
  if (verdictFile) {
    fs.writeFileSync(verdictFile, `${JSON.stringify({ reviewed: problems.length === 0, findings: problems })}\n`);
  }
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`install scripts: ${problem}\n`);
    if (!writing) {
      process.stderr.write(`After reviewing, record the new state with: node ${path.relative(process.cwd(), __filename)} ${dirs[0]} --write\n`);
    }
    return 1;
  }
  const names = Object.keys(packages);
  process.stdout.write(`install scripts: ${writing ? 'recorded' : 'as reviewed'} (${names.length ? names.join(', ') : 'none allowed'})\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, write, fingerprint, RECORD };
