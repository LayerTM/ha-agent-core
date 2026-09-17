'use strict';

// A stand-in agent process for the core's run tests. It reads its whole stdin,
// then plays the tape given as its only argument (a JSON array of steps):
//   { emit: <object> }          one JSON line on stdout
//   { raw: <string> }           a raw stdout line (not JSON)
//   { stdout: <bytes> }         that many bytes of stdout without a newline
//   { stderr: <string> }        text on stderr
//   { sleep: <ms> }             wait
//   { hang: true }              never finish on its own
//   { echo: 'stdin' | 'env' }   a result event whose text is the stdin, or the
//                               environment as JSON
//   { exit: <code> }            exit with that code (default 0 at the end)

const tape = JSON.parse(process.argv[2] || '[]');

function write(line) {
  return new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
}

async function play(input) {
  for (const step of tape) {
    if (step.emit) await write(JSON.stringify(step.emit));
    else if (typeof step.raw === 'string') await write(step.raw);
    else if (step.stdout) await new Promise((r) => process.stdout.write('x'.repeat(step.stdout), r));
    else if (typeof step.stderr === 'string') process.stderr.write(step.stderr);
    else if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
    else if (step.hang) await new Promise(() => setInterval(() => {}, 1000));
    else if (step.echo) {
      const text = step.echo === 'env' ? JSON.stringify(process.env) : input;
      await write(JSON.stringify({ type: 'result', structured: { text, proposal: null, automation: null } }));
    } else if (typeof step.exit === 'number') process.exit(step.exit);
  }
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => { play(input); });
