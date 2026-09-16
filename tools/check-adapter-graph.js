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
 *   - the graph has no cycle.
 *
 * Every file under server/ and adapter/ is read, whatever its name. Loading is
 * accepted in one form only — require('<string literal>') — plus
 * require.resolve(...), which locates a file without running it. Anything else
 * that can load or evaluate code is refused rather than followed: require used
 * as a value, import() and import statements, module.require, createRequire,
 * Module._load, process.dlopen, eval, Function, the vm and module built-ins,
 * .mjs and .node files, and local requires of anything but .js, .cjs or .json
 * inside server/ or adapter/. A file the scanner cannot tokenise is refused too.
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
const CODE_EXT = new Set(['.js', '.cjs']);
const LOADABLE_EXT = new Set(['.js', '.cjs', '.json']);
const REFUSED_EXT = new Set(['.mjs', '.node']);
const REFUSED_BUILTINS = new Set(['vm', 'node:vm', 'module', 'node:module']);
const REFUSED_WORDS = ['createRequire', '_load', 'dlopen', 'eval', 'Function'];

function listFiles(tree) {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(tree, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.push({ rel: child, kind: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'other' });
    }
  };
  for (const root of ROOTS) {
    if (fs.existsSync(path.join(tree, root))) walk(root);
  }
  return files;
}

// Splits source into code, with every comment blanked and every string, template
// and regular-expression literal replaced by a same-length placeholder, plus the
// list of string literals by position. Throws when the text does not tokenise.
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function tokenise(source) {
  const parts = [];
  let length = 0;
  const out = {
    push(text) {
      parts.push(text);
      length += text.length;
    },
  };
  const strings = new Map(); // start offset in `code` -> literal value
  let i = 0;
  let lastSignificant = '';
  let lastWord = '';
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  const templateDepth = [];
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out.push(blank(source.slice(i, stop)));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated comment');
      out.push(blank(source.slice(i, end + 2)));
      i = end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      for (; j < source.length && source[j] !== c; j += 1) {
        if (source[j] === '\\') {
          value += source[j + 1];
          j += 1;
        } else if (source[j] === '\n') {
          throw new Error('unterminated string');
        } else {
          value += source[j];
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      strings.set(length, value);
      out.push(c + 'S'.repeat(j - i - 1) + c);
      i = j + 1;
      lastSignificant = c;
      lastWord = '';
    } else if (c === '`' || (c === '}' && templateDepth.length && templateDepth[templateDepth.length - 1] === 0)) {
      // A template (or the rest of one after a ${ } substitution).
      if (c === '}') templateDepth.pop();
      let j = i + 1;
      for (; j < source.length; j += 1) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '`') break;
        else if (source[j] === '$' && source[j + 1] === '{') break;
      }
      if (j >= source.length) throw new Error('unterminated template');
      if (source[j] === '`') {
        out.push(c + 'T'.repeat(j - i - 1) + '`');
        i = j + 1;
        lastSignificant = '`';
      } else {
        out.push(c + 'T'.repeat(j - i - 1) + '${');
        templateDepth.push(0);
        i = j + 2;
        lastSignificant = '{';
      }
      lastWord = '';
    } else if (c === '/' && (REGEX_AFTER.has(lastSignificant) || REGEX_AFTER_WORDS.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      for (; j < source.length; j += 1) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '\n') throw new Error('unterminated regular expression');
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
      }
      if (j >= source.length) throw new Error('unterminated regular expression');
      out.push('/' + 'R'.repeat(j - i - 1) + '/');
      i = j + 1;
      lastSignificant = ')';
      lastWord = '';
    } else {
      if (templateDepth.length) {
        if (c === '{') templateDepth[templateDepth.length - 1] += 1;
        else if (c === '}') templateDepth[templateDepth.length - 1] -= 1;
      }
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 64));
      if (word) {
        out.push(word[0]);
        i += word[0].length;
        lastWord = word[0];
        lastSignificant = 'a';
      } else {
        out.push(c);
        i += 1;
        if (!/\s/.test(c)) {
          lastSignificant = c;
          lastWord = '';
        }
      }
    }
  }
  if (templateDepth.length) throw new Error('unterminated template substitution');
  return { code: parts.join(''), strings };
}

// The loading forms found in one file: literal requires, plus every refused form.
function loads(source) {
  const { code, strings } = tokenise(source);
  const specs = [];
  const refused = [];
  const requireRe = /(?<![\w$])require\b/g;
  for (let m = requireRe.exec(code); m; m = requireRe.exec(code)) {
    const after = code.slice(m.index + 7);
    const call = /^\s*\(\s*/.exec(after);
    if (call) {
      const at = m.index + 7 + call[0].length;
      const literal = strings.get(at);
      const quoted = literal !== undefined ? /^(['"])S*\1\s*\)/.exec(code.slice(at)) : null;
      if (quoted) {
        specs.push(literal);
        continue;
      }
      refused.push('require() with an argument that is not a string literal');
    } else if (/^\s*\.\s*resolve\s*\(/.test(after)) {
      continue;
    } else if (code.slice(0, m.index).trimEnd().endsWith('.')) {
      refused.push('a property named require');
    } else {
      refused.push('require used as a value');
    }
  }
  if (/(?<![\w$.])import\s*\(/.test(code)) refused.push('import()');
  if (/(?:^|[;\n])\s*import[\s{*'"]/.test(code)) refused.push('an import statement');
  if (/(?<![\w$])module\s*\.\s*require\b/.test(code)) refused.push('module.require');
  for (const name of REFUSED_WORDS) {
    if (new RegExp(`(?<![\\w$])${name.replace('$', '\\$')}(?![\\w$])`).test(code)) refused.push(name);
  }
  for (const spec of specs) {
    if (REFUSED_BUILTINS.has(spec)) refused.push(`require('${spec}')`);
  }
  return { specs, refused: [...new Set(refused)] };
}

function resolveLocal(tree, fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}/index.js`]) {
    const full = path.join(tree, candidate);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isFile()) return candidate;
  }
  return null;
}

function isAdapter(rel) {
  return rel === 'adapter' || rel.startsWith('adapter/');
}

function inRoots(rel) {
  return ROOTS.some((root) => rel.startsWith(`${root}/`));
}

function check(tree) {
  const problems = [];
  const edges = new Map();
  const files = listFiles(tree);
  for (const { rel, kind } of files) {
    const ext = path.posix.extname(rel);
    if (kind !== 'file') {
      problems.push(`${rel}: ${kind === 'link' ? 'symlink' : 'special file'} in the module tree`);
      continue;
    }
    if (REFUSED_EXT.has(ext)) {
      problems.push(`${rel}: ${ext} modules are not supported`);
      continue;
    }
    if (!CODE_EXT.has(ext)) continue; // data and assets: loaded only if required, checked there
    let found;
    try {
      found = loads(fs.readFileSync(path.join(tree, rel), 'utf8'));
    } catch (err) {
      problems.push(`${rel}: cannot be scanned (${err.message})`);
      continue;
    }
    for (const form of found.refused) problems.push(`${rel}: unsupported loading form: ${form}`);
    const targets = [];
    for (const spec of found.specs) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // node: built-ins and packages
      if (spec.startsWith('/')) {
        problems.push(`${rel}: require('${spec}') is an absolute path`);
        continue;
      }
      const target = resolveLocal(tree, rel, spec);
      if (!target) {
        problems.push(`${rel}: require('${spec}') does not resolve to a file`);
        continue;
      }
      if (!inRoots(target)) {
        problems.push(`${rel}: require('${spec}') leaves server/ and adapter/`);
        continue;
      }
      if (!LOADABLE_EXT.has(path.posix.extname(target))) {
        problems.push(`${rel}: require('${spec}') loads ${target}, which is not .js, .cjs or .json`);
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
  return { files: edges.size, problems };
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

module.exports = { check, loads, tokenise };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
