#!/usr/bin/env node
'use strict';

/*
 * Checks the module graph of an assembled console tree (the directory that holds
 * server/ and, in an add-on, adapter/):
 *
 *   - the core loads the adapter in exactly one place, server/adapter-contract.js,
 *     and that module requires nothing else of the tree;
 *   - adapter modules require only each other and the core's leaf modules, never
 *     the console, tmux or the prompt server — they return data, the core acts;
 *   - leaf modules require nothing of the tree;
 *   - every local require is a string literal that resolves to a file;
 *   - the graph has no cycle.
 *
 * Dependency-free, so an add-on runs it from the installed core against its
 * assembled tree:  node check-adapter-graph.js <tree>
 * Exit: 0 clean, 1 violations, 2 usage error.
 */

const fs = require('node:fs');
const path = require('node:path');

const LOADER = 'server/adapter-contract.js';
const LEAVES = new Set(['server/prompt/security.js']);
const ROOTS = ['server', 'adapter'];

function listJs(tree) {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(tree, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isSymbolicLink()) files.push({ rel: child, link: true });
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && child.endsWith('.js')) files.push({ rel: child, link: false });
    }
  };
  for (const root of ROOTS) {
    if (fs.existsSync(path.join(tree, root))) walk(root);
  }
  return files;
}

// Every `require(` call: its argument text and whether it is a plain string.
function requires(source) {
  const found = [];
  const re = /\brequire\s*\(\s*([^)]*?)\s*\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const literal = /^(['"])([^'"`\\]+)\1$/.exec(m[1]);
    found.push(literal ? { spec: literal[2] } : { dynamic: m[1] });
  }
  return found;
}

function resolveLocal(tree, fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const candidate of [base, `${base}.js`, `${base}/index.js`]) {
    const full = path.join(tree, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return candidate;
  }
  return null;
}

function isAdapter(rel) {
  return rel === 'adapter' || rel.startsWith('adapter/');
}

function check(tree) {
  const problems = [];
  const edges = new Map();
  const files = listJs(tree);
  for (const { rel, link } of files) {
    if (link) {
      problems.push(`${rel}: symlink in the module tree`);
      continue;
    }
    // Stripping comments keeps prose about require() from counting as a call.
    const source = fs.readFileSync(path.join(tree, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const targets = [];
    for (const req of requires(source)) {
      if (req.dynamic !== undefined) {
        problems.push(`${rel}: require(${req.dynamic}) is not a string literal`);
        continue;
      }
      if (!req.spec.startsWith('.')) continue; // node: built-ins and packages
      const target = resolveLocal(tree, rel, req.spec);
      if (!target) {
        problems.push(`${rel}: require('${req.spec}') does not resolve to a file`);
        continue;
      }
      targets.push(target);
    }
    edges.set(rel, targets);

    for (const target of targets) {
      if (LEAVES.has(rel)) problems.push(`${rel}: a leaf module requires ${target}`);
      if (rel === LOADER && !isAdapter(target)) problems.push(`${rel}: the adapter loader requires ${target}`);
      if (isAdapter(target) && !isAdapter(rel) && rel !== LOADER) {
        problems.push(`${rel}: requires the adapter directly (only ${LOADER} may)`);
      }
      if (isAdapter(rel) && !isAdapter(target) && !LEAVES.has(target)) {
        problems.push(`${rel}: an adapter module requires core module ${target} (only leaves are allowed)`);
      }
    }
  }
  if (!edges.has(LOADER)) problems.push(`${LOADER}: missing`);

  // Cycle detection (iterative colouring).
  const colour = new Map();
  for (const start of edges.keys()) {
    if (colour.get(start)) continue;
    const stack = [[start, 0]];
    colour.set(start, 'grey');
    const trail = [start];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = (edges.get(frame[0]) || [])[frame[1]];
      frame[1] += 1;
      if (next === undefined) {
        colour.set(frame[0], 'black');
        stack.pop();
        trail.pop();
      } else if (colour.get(next) === 'grey') {
        problems.push(`cycle: ${[...trail.slice(trail.indexOf(next)), next].join(' -> ')}`);
      } else if (!colour.get(next)) {
        colour.set(next, 'grey');
        stack.push([next, 0]);
        trail.push(next);
      }
    }
  }
  return { files: files.length, problems };
}

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write('usage: check-adapter-graph.js <tree>\n');
    return 2;
  }
  const tree = path.resolve(argv[0]);
  if (!fs.existsSync(path.join(tree, 'server'))) {
    process.stderr.write(`${tree} has no server/ directory\n`);
    return 2;
  }
  const { files, problems } = check(tree);
  if (problems.length) {
    process.stderr.write(`adapter graph: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`adapter graph: clean (${files} modules)\n`);
  return 0;
}

module.exports = { check, requires };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
