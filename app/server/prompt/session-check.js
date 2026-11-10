'use strict';

// Checks that the engine an add-on bundles still resets a warm session the way
// `prompt_keep_warm` relies on (session-pool.js): started with the read command
// line, the adapter's `clearLine()` must be answered by a reset its own reset
// reader recognises, in time, every time. An engine release that changes this
// silently would let one read's text reach the next, so an add-on runs this
// against its bundled engine on every engine update and fails the build when it
// does not hold.
//
// Usage, in the assembled tree:  node server/prompt/session-check.js [--bin PATH]
// Needs no sign-in: a reset is local to the engine.
// Exit status: 0 the reset holds, 1 it does not (the reason is printed), 2 the
// adapter has no session support.

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { adapter } = require('../adapter-contract');
const { launchSpec, childEnv } = require('./run');
const { RESET_MS } = require('./session-pool');

const RESETS = 3;

function main(argv) {
  const at = argv.indexOf('--bin');
  const bin = at >= 0 ? argv[at + 1] : adapter().runner.bin;
  const session = adapter().runner.session;
  if (!session) {
    console.error('session-check: the engine adapter declares no session support');
    return Promise.resolve(2);
  }
  // A read's command line, as a house read without Home Assistant would get it.
  const spec = {
    ...launchSpec({
      mcpConfigPath: undefined, model: undefined, imagePath: undefined, language: undefined, surface: undefined,
      editAutomation: undefined, memory: undefined, haTools: undefined, settings: undefined, web: null, stream: false,
    }),
    session: true,
  };
  const command = adapter().runner.launch(spec, { env: process.env });
  const child = spawn(bin, command.args, {
    cwd: os.tmpdir(), env: childEnv(process.env, command.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d; });
  return new Promise((resolve) => {
    let done = 0;
    let reader = null;
    let timer = null;
    let buf = '';
    let finished = false;
    const end = (code, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      if (typeof adapter().runner.endRun === 'function') adapter().runner.endRun(spec);
      console[code === 0 ? 'log' : 'error'](`session-check: ${message}`);
      resolve(code);
    };
    const clear = () => {
      reader = session.createResetReader();
      timer = setTimeout(() => end(1, `reset ${done + 1} did not complete within ${RESET_MS} ms${stderr ? `; stderr: ${stderr.slice(0, 300)}` : ''}`), RESET_MS);
      child.stdin.write(`${session.clearLine()}\n`);
    };
    child.on('error', (err) => end(1, `the engine did not start: ${err.message}`));
    child.on('close', (code) => end(1, `the engine exited (${code}) after ${done} of ${RESETS} resets${stderr ? `; stderr: ${stderr.slice(0, 300)}` : ''}`));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (reader && reader(parsed) === true) {
          clearTimeout(timer);
          reader = null;
          done += 1;
          if (done === RESETS) { end(0, `${RESETS} resets completed`); return; }
          clear();
        }
      }
    });
    clear();
  });
}

// Run as a script (not when a test loads it).
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main };
