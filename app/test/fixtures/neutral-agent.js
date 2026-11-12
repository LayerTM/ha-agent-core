'use strict';

// A test agent process for the core's run tests. It reads its whole stdin,
// then plays the tape in the file named by its only argument (a JSON array of
// steps; a file, because one argument is limited to 128 KiB on Linux):
//   { emit: <object> }          one JSON line on stdout
//   { lines: [<object>, ...] }  several JSON lines in ONE stdout write
//   { raw: <string> }           a raw stdout line (not JSON)
//   { stdout: <bytes> }         that many bytes of stdout without a newline
//   { stderr: <string> }        text on stderr
//   { sleep: <ms> }             wait
//   { hang: true }              never finish on its own
//   { echo: 'stdin' | 'env' }   a result event whose text is the stdin, or the
//                               environment as JSON
//   { exit: <code> }            exit with that code (default 0 at the end)
//   { descendant: <file> }      start a long-running process in the agent's
//                               group, detached from its output, and write its
//                               pid to <file>
//   { pid: <file> }             write the agent's own pid to <file>
//   { mark: <file> }            write the current time (ms) to <file>

// Session mode (`--session <conf>`): one turn per stdin line. A `user` line plays
// its own tape, where `{ echo: 'stdin' }` answers with the turn's text,
// `{ echo: 'memory' }` with every user text the agent still remembers and
// `{ echo: 'env' }` with the session's environment as JSON. A `clear`
// line emits `reset` and a 0-turn result, and forgets — unless the conf says it
// does not honour a reset, or does not forget.
if (process.argv[2] === '--session') {
  const conf = JSON.parse(require('node:fs').readFileSync(process.argv[3], 'utf8'));
  const memory = [];
  const out = (o) => new Promise((r) => process.stdout.write(`${JSON.stringify(o)}\n`, r));
  let queue = Promise.resolve();
  let buf = '';
  const turn = async (msg) => {
    if (msg.type === 'clear') {
      if (!conf.honourClear) return;
      if (conf.forget) memory.length = 0;
      await out({ type: 'reset' });
      await out({ type: 'result', numTurns: 0, structured: null });
      return;
    }
    memory.push(msg.text);
    for (const step of msg.tape || []) {
      if (step.emit) await out(step.emit);
      else if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
      else if (step.hang) await new Promise(() => setInterval(() => {}, 1000));
      else if (step.pid) require('node:fs').writeFileSync(step.pid, String(process.pid));
      else if (typeof step.exit === 'number') process.exit(step.exit);
      else if (step.echo) {
        const text = step.echo === 'memory' ? memory.slice(0, -1).join(' | ')
          : step.echo === 'env' ? JSON.stringify(process.env) : msg.text;
        await out({ type: 'result', structured: { text, proposal: null, automation: null }, numTurns: 1 });
      }
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line);
      queue = queue.then(() => turn(msg));
    }
  });
  process.stdin.on('end', () => queue.then(() => process.exit(0)));
} else {
  runTape();
}

function runTape() {
  const tape = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));

  function write(line) {
    return new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
  }

  async function play(input) {
    for (const step of tape) {
      if (step.emit) await write(JSON.stringify(step.emit));
      else if (Array.isArray(step.lines)) await write(step.lines.map((l) => JSON.stringify(l)).join('\n'));
      else if (step.pid) require('node:fs').writeFileSync(step.pid, String(process.pid));
      else if (step.mark) require('node:fs').writeFileSync(step.mark, String(Date.now()));
      else if (typeof step.raw === 'string') await write(step.raw);
      else if (step.stdout) await new Promise((r) => process.stdout.write('x'.repeat(step.stdout), r));
      else if (typeof step.stderr === 'string') process.stderr.write(step.stderr);
      else if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
      else if (step.hang) await new Promise(() => setInterval(() => {}, 1000));
      else if (step.echo) {
        const text = step.echo === 'env' ? JSON.stringify(process.env) : input;
        await write(JSON.stringify({ type: 'result', structured: { text, proposal: null, automation: null } }));
      } else if (step.descendant) {
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        child.unref();
        require('node:fs').writeFileSync(step.descendant, String(child.pid));
      } else if (typeof step.exit === 'number') process.exit(step.exit);
    }
    process.exit(0);
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => { play(input); });
}
