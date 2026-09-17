#!/usr/bin/env node
'use strict';

/*
 * Runs the install scripts of the packages package.json `allowScripts` names, in
 * a directory that holds nothing but their reviewed closures.
 *
 * Run it in an installed directory (after `npm ci --ignore-scripts` and a passing
 * tools/check-install-scripts.js). For the allowed packages it:
 *   1. copies every package of their closures, by its lockfile path and without
 *      any nested node_modules, into a new staging directory, next to a
 *      package.json that names only them;
 *   2. runs `npm rebuild --strict-allow-scripts` there, with npm given by its
 *      absolute path (NPM_CLI, the npm-cli.js the caller resolved), npm's own
 *      node-gyp, a PATH of the Node.js directory and the system directories, and
 *      an empty HOME, npm cache and npm configuration;
 *   3. copies the packages back over the installed ones, with what their scripts
 *      built.
 *
 * So an install script finds only reviewed packages: npm puts the staging
 * directory's node_modules/.bin first on the PATH, and it holds the bins of the
 * closure alone; a package outside the closure, hoisted or not, is not there.
 *
 * Dependency-free. Exit: 0 built (or nothing to build), 1 failure, 2 usage error.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkDir } = require('./check-install-scripts.js');

const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin'];

function copyPackage(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    // A package's own node_modules holds other packages; each closure member is
    // copied by its own lockfile path instead.
    filter: (src) => path.relative(from, src).split(path.sep)[0] !== 'node_modules',
  });
}

function main() {
  const dir = process.cwd();
  const npmCli = process.env.NPM_CLI;
  if (!npmCli || !path.isAbsolute(npmCli) || !fs.existsSync(npmCli)) {
    process.stderr.write('build-allowed-packages: NPM_CLI must be the absolute path of npm-cli.js\n');
    return 2;
  }
  const { closures, problems } = checkDir(dir);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`install scripts: ${problem}\n`);
    if (process.env.INSTALL_SCRIPTS_UNREVIEWED !== 'build') return 1;
  }
  // An allowed package the install left out (npm ci --omit) has nothing to build.
  const names = Object.keys(closures)
    .filter((name) => fs.existsSync(path.join(dir, 'node_modules', name, 'package.json')));
  if (names.length === 0) return 0;

  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-build-'));
  try {
    // npm also searches every parent of the stage for node_modules/.bin, so no
    // parent may hold a node_modules (a temporary directory inside a project,
    // or a shared one somebody wrote a node_modules into).
    for (let up = path.dirname(fs.realpathSync(stage)); ; up = path.dirname(up)) {
      if (fs.existsSync(path.join(up, 'node_modules'))) {
        process.stderr.write(`build-allowed-packages: ${up} holds a node_modules; set TMPDIR to a directory outside any project\n`);
        return 1;
      }
      if (path.dirname(up) === up) break;
    }
    const paths = [...new Set(names.flatMap((name) => Object.keys(closures[name])))].sort();
    for (const rel of paths) copyPackage(path.join(dir, rel), path.join(stage, rel));
    const dependencies = Object.fromEntries(names.map((name) => [name, lock.packages[`node_modules/${name}`]?.version ?? '*']));
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
      name: 'allowed-build',
      private: true,
      dependencies,
      allowScripts: Object.fromEntries(names.map((name) => [name, true])),
    }));
    fs.mkdirSync(path.join(stage, '.home'));
    fs.writeFileSync(path.join(stage, '.npmrc-user'), '');
    fs.writeFileSync(path.join(stage, '.npmrc-global'), '');

    const npmRoot = path.dirname(path.dirname(npmCli));
    const env = {
      PATH: [path.dirname(process.execPath), ...SYSTEM_PATH].join(path.delimiter),
      HOME: path.join(stage, '.home'),
      LANG: process.env.LANG || 'C.UTF-8',
      npm_config_userconfig: path.join(stage, '.npmrc-user'),
      npm_config_globalconfig: path.join(stage, '.npmrc-global'),
      npm_config_cache: path.join(stage, '.home', 'npm-cache'),
      npm_config_update_notifier: 'false',
      npm_config_node_gyp: path.join(npmRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    };
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('npm_package_config_node_gyp_')) env[key] = value;
    }
    const run = spawnSync(process.execPath, [npmCli, 'rebuild', '--strict-allow-scripts'], {
      cwd: stage, env, stdio: 'inherit',
    });
    if (run.status !== 0) {
      process.stderr.write(`build-allowed-packages: npm rebuild failed (${run.status ?? run.signal})\n`);
      return 1;
    }
    for (const rel of paths) copyPackage(path.join(stage, rel), path.join(dir, rel));
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) process.exitCode = main();
