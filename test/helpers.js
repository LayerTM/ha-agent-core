'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
};

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, encoding: 'utf8' });
}

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function packageJson(overrides = {}) {
  return `${JSON.stringify({
    name: 'ha-agent-core',
    version: '1.2.3',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/example/ha-agent-core.git' },
    haAgentCore: { adapterApi: 1 },
    files: ['LICENSE', 'package.json', 'package-lock.json', 'src/'],
    ...overrides,
  }, null, 2)}\n`;
}

const BASE_FILES = {
  LICENSE: 'MIT License\n',
  'package-lock.json': '{"lockfileVersion": 3}\n',
  'src/index.js': 'module.exports = 1;\n',
  'src/deep/tool.sh': '#!/bin/sh\necho ok\n',
  'test/ignored.js': 'not packed\n',
};

// A git repository with one commit holding these files. A value of
// { link: target } makes a symlink; { mode: 0o755, text } an executable file.
function makeRepo(t, files = {}, pkg = packageJson()) {
  const repo = tempDir(t);
  git(repo, 'init', '-q');
  const all = { ...BASE_FILES, 'package.json': pkg, 'src/deep/tool.sh': { mode: 0o755, text: BASE_FILES['src/deep/tool.sh'] }, ...files };
  for (const [rel, spec] of Object.entries(all)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (typeof spec === 'string') fs.writeFileSync(full, spec);
    else if (spec.link) fs.symlinkSync(spec.link, full);
    else {
      fs.writeFileSync(full, spec.text);
      fs.chmodSync(full, spec.mode);
    }
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  return repo;
}

module.exports = { git, tempDir, makeRepo, packageJson };
