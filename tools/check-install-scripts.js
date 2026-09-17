#!/usr/bin/env node
'use strict';

/*
 * Decides from the lockfile alone whether the install scripts npm would run are
 * the reviewed ones. It reads JSON and executes nothing, so it can judge a
 * dependency tree before a single file of it is unpacked, or a lockfile fetched
 * as plain data.
 *
 * npm runs a dependency's install scripts only for packages named in the
 * `allowScripts` field of package.json. What such a script can run is the
 * package itself and the packages it depends on, so the reviewed unit is that
 * closure: for each allowed package, every package reachable through its
 * declared dependencies, each pinned by its registry tarball URL and integrity
 * hash (the digest of every file in the tarball). The reviewed closures live in
 * install-scripts.json next to package.json.
 *
 * Not reviewed, and reported, is anything that differs from the record or that
 * this data cannot vouch for:
 *   - a package added to, removed from or changed in a closure;
 *   - a closure package without an integrity hash, or not from the npm registry;
 *   - any package with an install script that allowScripts does not name
 *     (an explicit `false` entry is fine: npm never runs it);
 *   - an allowScripts entry that is not a bare package name, or an allowed
 *     package the lockfile does not have, or a record for a package that is no
 *     longer allowed.
 *
 * The toolchain the scripts use (node, npm and its node-gyp, python, make, the
 * C/C++ compiler) is not in the lockfile; the image that runs the install pins it.
 *
 *   check-install-scripts.js <dir>
 *   check-install-scripts.js <dir> --write
 *   check-install-scripts.js --package FILE --lock FILE --record FILE
 *
 * <dir> holds package.json, package-lock.json and, when anything is allowed,
 * install-scripts.json. The explicit form reads the three files from anywhere
 * (a missing record file means nothing is reviewed).
 * Dependency-free. Exit: 0 as reviewed, 1 not reviewed, 2 usage error.
 */

const fs = require('node:fs');
const path = require('node:path');

const RECORD = 'install-scripts.json';
const REGISTRY = 'https://registry.npmjs.org/';
const NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const TOOLCHAIN = 'node, npm and its node-gyp, python, make and the C/C++ compiler come from the image that runs the install';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function allowed(pkg) {
  const problems = [];
  const names = [];
  const denied = new Set();
  const entries = pkg.allowScripts === undefined ? {} : pkg.allowScripts;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    return { names, denied, problems: ['allowScripts is not an object'] };
  }
  for (const [key, value] of Object.entries(entries)) {
    if (!NAME_RE.test(key)) {
      problems.push(`allowScripts entry "${key}" is not a bare package name; the record pins the versions`);
    } else if (value === true) {
      names.push(key);
    } else if (value === false) {
      denied.add(key);
    } else {
      problems.push(`allowScripts entry "${key}" is neither true nor false`);
    }
  }
  return { names: names.sort(), denied, problems };
}

// The lockfile path a dependency of the package at `from` resolves to, the way
// npm lays out node_modules: the nearest node_modules/<name> up the tree.
function resolveIn(packages, from, name) {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

// Every lockfile entry reachable from `root` through declared dependencies.
function closure(packages, root, problems, label) {
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key];
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(entry[field] || {})) {
        const target = resolveIn(packages, key, dep);
        if (target) queue.push(target);
        else if (field === 'dependencies') {
          problems.push(`${label}: ${key} depends on ${dep}, which the lockfile does not have`);
        }
      }
    }
  }
  return [...seen].sort();
}

function pin(key, entry, problems, label) {
  if (entry.link) {
    problems.push(`${label}: ${key} is a link, not a registry package`);
  } else if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) {
    problems.push(`${label}: ${key} does not come from the npm registry (${JSON.stringify(entry.resolved ?? null)})`);
  } else if (typeof entry.integrity !== 'string' || !INTEGRITY_RE.test(entry.integrity)) {
    problems.push(`${label}: ${key} has no sha512 integrity`);
  }
  return { version: entry.version ?? null, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null };
}

// The closures of the allowed packages as the lockfile states them.
function current(pkg, lock) {
  const { names, denied, problems } = allowed(pkg);
  const packages = lock && lock.packages && typeof lock.packages === 'object' ? lock.packages : null;
  if (!packages || !(lock.lockfileVersion >= 2)) {
    return { closures: {}, problems: [...problems, 'package-lock.json has no "packages" map (lockfile version 2 or later)'] };
  }

  const closures = {};
  for (const name of names) {
    const roots = Object.keys(packages)
      .filter((k) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
      .sort();
    if (roots.length === 0) {
      problems.push(`${name}: allowed in allowScripts but not in package-lock.json`);
      continue;
    }
    const pinned = {};
    for (const root of roots) {
      for (const key of closure(packages, root, problems, name)) {
        pinned[key] = pin(key, packages[key], problems, name);
      }
    }
    closures[name] = pinned;
  }

  for (const [key, entry] of Object.entries(packages)) {
    if (!key || !entry || !entry.hasInstallScript) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!names.includes(name) && !denied.has(name)) {
      problems.push(`${key} has an install script that allowScripts does not name`);
    }
  }
  return { closures, problems };
}

function compare(recorded, closures) {
  const problems = [];
  for (const name of Object.keys(recorded)) {
    if (!(name in closures)) problems.push(`${name}: reviewed in ${RECORD} but not allowed in allowScripts`);
  }
  for (const [name, now] of Object.entries(closures)) {
    const was = recorded[name];
    if (!was) {
      problems.push(`${name}: allowed in allowScripts but not reviewed in ${RECORD}`);
      continue;
    }
    for (const key of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
      const a = was[key];
      const b = now[key];
      if (!b) problems.push(`${name}: ${key} left the reviewed closure`);
      else if (!a) problems.push(`${name}: review ${key}@${b.version}, new in the closure`);
      else if (a.resolved !== b.resolved || a.integrity !== b.integrity) {
        problems.push(`${name}: review ${key}, ${a.version} -> ${b.version}${a.version === b.version ? ' (different bytes)' : ''}`);
      }
    }
  }
  return problems;
}

function readRecord(file) {
  if (!fs.existsSync(file)) return {};
  const record = readJson(file);
  return record && record.packages && typeof record.packages === 'object' ? record.packages : {};
}

function check({ pkg, lock, record }) {
  const { closures, problems } = current(pkg, lock);
  return { closures, problems: [...problems, ...compare(record, closures)] };
}

function checkDir(dir) {
  return check({
    pkg: readJson(path.join(dir, 'package.json')),
    lock: readJson(path.join(dir, 'package-lock.json')),
    record: readRecord(path.join(dir, RECORD)),
  });
}

function write(dir) {
  const result = current(readJson(path.join(dir, 'package.json')), readJson(path.join(dir, 'package-lock.json')));
  if (result.problems.length === 0) {
    const doc = {
      about: 'The reviewed dependency closures of the packages allowScripts lets npm run install scripts for;'
        + ' written by tools/check-install-scripts.js --write after a review.',
      toolchain: TOOLCHAIN,
      packages: result.closures,
    };
    fs.writeFileSync(path.join(dir, RECORD), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return result;
}

function parseArgs(argv) {
  const opts = { files: {}, write: false, dir: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') {
      opts.write = true;
    } else if (a === '--package' || a === '--lock' || a === '--record') {
      if (argv[i + 1] === undefined) return null;
      opts.files[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      rest.push(a);
    }
  }
  const explicit = Object.keys(opts.files).length;
  if (explicit) return explicit === 3 && rest.length === 0 && !opts.write ? opts : null;
  if (rest.length !== 1 || !fs.existsSync(path.join(rest[0], 'package.json'))) return null;
  opts.dir = rest[0];
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) {
    process.stderr.write('usage: check-install-scripts.js <dir> [--write]\n'
      + '       check-install-scripts.js --package FILE --lock FILE --record FILE\n');
    return 2;
  }
  let result;
  try {
    if (opts.write) result = write(opts.dir);
    else if (opts.dir) result = checkDir(opts.dir);
    else {
      result = check({
        pkg: readJson(opts.files.package),
        lock: readJson(opts.files.lock),
        record: readRecord(opts.files.record),
      });
    }
  } catch (err) {
    result = { closures: {}, problems: [`cannot read the manifests: ${err.message}`] };
  }
  if (result.problems.length) {
    for (const problem of result.problems) process.stderr.write(`install scripts: ${problem}\n`);
    if (!opts.write) {
      process.stderr.write('After reviewing the packages named, record them with: check-install-scripts.js <dir> --write\n');
    }
    return 1;
  }
  const names = Object.keys(result.closures);
  process.stdout.write(`install scripts: ${opts.write ? 'recorded' : 'as reviewed'} (${names.length ? names.join(', ') : 'none allowed'})\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

// Whether `npm ci --omit=<omit…>` leaves out the package at a lockfile path, by
// the flags npm wrote there. `omitList` is the comma-separated INSTALL_OMIT the
// install wrapper sets (dev, optional, peer). A devOptional package is left out
// only when both dev and optional are.
function omittedByInstall(lock, key, omitList = '') {
  const omit = new Set(String(omitList).split(',').filter(Boolean));
  const entry = lock && lock.packages && lock.packages[key];
  if (!entry) return false;
  return Boolean((entry.dev && omit.has('dev'))
    || (entry.optional && omit.has('optional'))
    || (entry.peer && omit.has('peer'))
    || (entry.devOptional && omit.has('dev') && omit.has('optional')));
}

module.exports = { check, checkDir, write, omittedByInstall, RECORD };
