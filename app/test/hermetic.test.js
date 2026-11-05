'use strict';

// Every test script runs through test-support/hermetic-test.js, so a test cannot
// reach another machine and fails if it tries. Each case drives the runner as a
// child with its own record; 192.0.2.1 is TEST-NET-1, which is never routed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const RUNNER = path.join(__dirname, '..', 'test-support', 'hermetic-test.js');
const FAR = '192.0.2.1';
// Never a name that may resolve: if the guard regresses, these calls really run.
const NAME = 'core-name.invalid';
const BOUND = 20000;

function underGuard(script) {
  return spawnSync(process.execPath, [RUNNER, process.execPath, '-e', script], { encoding: 'utf8', timeout: BOUND });
}

function shellUnderGuard(script) {
  return spawnSync(process.execPath, [RUNNER, 'bash', '-c', script], { encoding: 'utf8', timeout: BOUND });
}

test('this suite itself runs guarded: run without the runner, it is red', () => {
  assert.equal(net.Socket.prototype.connect.name, 'hermeticConnect');
  assert.ok(process.env.HERMETIC_RECORD, 'no record: the suite was not started through the runner');
});

test('every test script of the core goes through the runner', () => {
  const root = path.join(__dirname, '..', '..');
  for (const manifest of ['package.json', 'app/package.json']) {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
    const tests = Object.entries(scripts).filter(([name]) => /^test(:|$)/.test(name));
    assert.ok(tests.length > 0, `${manifest} has no test script`);
    for (const [name, line] of tests) {
      assert.match(line, /^node \S*test-support\/hermetic-test\.js /, `${manifest} ${name}: ${line}`);
    }
  }
});

test('the image suite gives its containers no network', () => {
  const suite = fs.readFileSync(path.join(__dirname, 'image.test.sh'), 'utf8');
  const runs = suite.split('\n').filter((line) => /^\s*docker run\b/.test(line));
  assert.ok(runs.length > 0, 'no docker run found: this check no longer reads the suite');
  for (const line of runs) assert.match(line, /--network none\b/, line);
});

const ATTEMPTS = {
  'fetch by name': `fetch('http://${NAME}:8123/api/mcp').catch(() => {});`,
  'fetch by address': `fetch('http://${FAR}:8123/').catch(() => {});`,
  'http.request': `require('node:http').get('http://${FAR}/').on('error', () => {});`,
  'https.request': `require('node:https').get('https://${FAR}/').on('error', () => {});`,
  'net.connect': `require('node:net').connect(80, '${FAR}').on('error', () => {});`,
  'tls.connect': `require('node:tls').connect(443, '${FAR}').on('error', () => {});`,
  'a child inheriting the environment': `require('node:child_process').spawnSync(process.execPath,
    ['-e', "require('node:net').connect(80, '${FAR}').on('error', () => {})"]);`,
};

for (const [what, script] of Object.entries(ATTEMPTS)) {
  test(`${what}: refused, and the run fails although the error was swallowed`, () => {
    const result = underGuard(script);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /tried to leave the machine/);
    assert.match(result.stderr, /node connected to /);
  });
}

test('the refused destination and the caller are named', () => {
  const result = underGuard(`fetch('http://${NAME}:8123/api/mcp').catch(() => {});`);
  assert.match(result.stderr, /core-name\.invalid:8123/);
  assert.match(result.stderr, /\n\s+at /);
});

for (const tool of ['curl', 'wget']) {
  test(`${tool} to another machine is refused and fails the run, even with its status thrown away`, () => {
    const result = shellUnderGuard(`${tool} http://${FAR}/ || true`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`${tool} called with http://${FAR}/`));
  });
}

const REFUSED_CALLS = [
  // No scheme: the tool assumes http.
  `curl ${NAME}:8123/api`,
  `curl ${NAME}`,
  'curl core-name-with-no-dot',
  `curl ${FAR}`,
  `curl -sS ${NAME}:8123/api`,
  `curl -m 5 ${FAR}`,
  `curl -m5 -o/dev/null ${FAR}`,
  `curl -sSm 5 ${FAR}`,
  // The destination in an option.
  `curl --url=http://${NAME}:8123/`,
  `curl --url=${NAME}:8123/api`,
  `curl --url ${NAME}:8123/api`,
  `curl -x http://${FAR}:3128 http://127.0.0.1:1/`,
  `curl --proxy=${FAR}:3128 http://127.0.0.1:1/`,
  // Names and addresses that only look local.
  'curl http://localhost.invalid/',
  'curl http://127.0.0.1.invalid/',
  `curl http://127.0.0.1@${FAR}/`,
  'curl 127.invalid',
  // An option this does not know: its value is taken for a destination, loudly.
  'curl --some-future-option value http://127.0.0.1:1/',
  // wget has its own options.
  `wget ${NAME}:8123/api`,
  `wget -q -O - ${FAR}/`,
  `wget --output-document=- ${FAR}`,
];

for (const call of REFUSED_CALLS) {
  test(`refused: ${call}`, () => {
    const result = shellUnderGuard(`${call} || true`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /called with /);
  });
}

const PASSING_CALLS = [
  'curl -sS -m 5 -o /dev/null -w "%{http_code}" -H "X-Test: yes" http://127.0.0.1:PORT/',
  'curl -sSm5 http://127.0.0.1:PORT/',
  'curl --silent --max-time 5 --output /dev/null http://localhost:PORT/',
  'curl -s --url 127.0.0.1:PORT',
  'curl -s localhost:PORT/x',
  'curl -s -d "body with spaces.and.dots" -X POST 127.0.0.1:PORT/',
  'printf "header = \\"X-Test: yes\\"\\n" | curl -K - -s http://127.0.0.1:PORT/',
  'curl --version',
  'curl -s file:///dev/null',
];

test('calls to this machine are passed on to the real tool', async () => {
  const server = http.createServer((req, res) => { req.resume(); res.end('ok'); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    for (const call of PASSING_CALLS) {
      // eslint-disable-next-line no-await-in-loop
      const result = await new Promise((resolve) => {
        execFile(process.execPath, [RUNNER, 'bash', '-c', call.replaceAll('PORT', String(port))], { encoding: 'utf8' },
          (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr }));
      });
      assert.equal(result.code, 0, `${call}: ${result.stderr}`);
    }
  } finally {
    server.close();
  }
});

test('a failing command keeps its own exit status', () => {
  assert.equal(underGuard('process.exit(3)').status, 3);
});

test('a command that cannot start fails the run', () => {
  const result = spawnSync(process.execPath, [RUNNER, 'no-such-command-here'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
});

test('loopback works: a clean run passes, through Node and through the real curl', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    // Asynchronous: the server this asks lives in this process.
    const run = (args) => new Promise((resolve) => {
      execFile(process.execPath, [RUNNER, ...args], { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    const viaCurl = await run(['bash', '-c', `curl -sS -m 5 http://127.0.0.1:${port}/`]);
    assert.equal(viaCurl.code, 0, viaCurl.stderr);
    assert.equal(viaCurl.stdout, 'ok');
    const viaNode = await run([process.execPath, '-e',
      `fetch('http://127.0.0.1:${port}/').then((r) => r.text()).then((t) => process.stdout.write(t));`]);
    assert.equal(viaNode.code, 0, viaNode.stderr);
    assert.equal(viaNode.stdout, 'ok');
  } finally {
    server.close();
  }
});
