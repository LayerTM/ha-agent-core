'use strict';

// Warm agent sessions for prompt-API reads (the `prompt_keep_warm` option).
//
// One agent process may serve several reads in turn, so a read does not pay for
// the agent starting and connecting its tools. What it must not do is carry
// anything from one read to the next. That is enforced here, in one place:
//
//   (a) No text of one turn reaches the next. Every turn ends with the engine's
//       reset (`runner.session.clearLine()`), and a session takes the next turn
//       only after the adapter's reset reader has seen the reset complete. A
//       reset that does not complete in time, or any output between turns, ends
//       the session; the next read then runs fresh.
//   (b) The session's bearer means the run it is serving and nothing else
//       (core-relay.js): bound to that run when a turn starts, unbound when it
//       ends and on every exit.
//   (c) The output path stays per run: a turn is handed to run() as a child of
//       its own, whose stdout carries only that turn's whole lines.
//   (d) A session serves only reads with the same command line (model,
//       language, surface, memory, schema, stream flag — everything but the
//       per-run MCP configuration path) and the same caller.
//
// The pool never starts a session on its own: a fresh read that succeeded
// starts one in the background for the reads after it.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { adapter } = require('../adapter-contract');

const POOL_CAP = 2;
const MAX_TURNS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RESET_MS = 2000;
// A turn whose input grew this far past the session's first turn means the
// reset did not reset; the session is ended rather than trusted.
const CONTEXT_GROWTH = 64 * 1024;
const MCP_PLACEHOLDER = '\u0000mcp-config\u0000';

function inputTotal(tokens) {
  let sum = 0;
  for (const t of Array.isArray(tokens) ? tokens : []) {
    sum += (Number(t.input) || 0) + (Number(t.cacheRead) || 0) + (Number(t.cacheWrite) || 0);
  }
  return sum;
}

// One turn of a session, shaped as the child process run() expects: its own
// stdout and stderr, a stdin whose `end(text)` sends the turn, and `close` if the
// process exits during the turn.
class Turn extends EventEmitter {
  constructor(pid, write, end) {
    super();
    this.pid = pid;
    this.warm = true;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { on() {}, write, end: (/** @type {unknown} */ text) => { if (typeof text === 'string') write(text); } };
    /** @type {(keep: boolean, tokens: unknown) => void} */
    this.end = end;
  }
}

function killProcessGroup(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * hooks: {
 *   open(): Promise<{token: string, mcpConfigPath: string|null, dir: string|null}>   a session bearer + its MCP config
 *   close(handle): Promise<void>                                                   revoke it, remove its files
 *   bind(token, runToken): boolean                                                 lend it one run for one turn
 *   unbind(token): void
 * }
 */
function createSessionPool({
  hooks, log = (m) => console.log(`[prompt] ${m}`), cap = POOL_CAP, maxTurns = MAX_TURNS, idleMs = IDLE_MS,
  resetMs = RESET_MS, contextGrowth = CONTEXT_GROWTH,
}) {
  /** @type {Map<string, Session>} */
  const sessions = new Map(); // insertion order = least recently used first
  let closed = false;

  class Session {
    constructor(key, handle, child, release) {
      this.key = key;
      this.handle = handle;
      this.child = child;
      this.release = release;
      this.state = 'clearing'; // clearing -> ready -> busy -> clearing ... | dead
      this.turns = 0;
      this.baseline = null;
      /** @type {Turn|null} */
      this.turn = null;
      this.timer = null;
      this.reset = null;
      this.lineBuffer = '';
      this.decoder = new StringDecoder('utf8');
      child.stdout.on('data', (chunk) => this.onStdout(chunk));
      child.stderr.on('data', (chunk) => { if (this.turn) this.turn.stderr.emit('data', chunk); });
      child.stdin.on('error', () => { /* the process is gone; close says so */ });
      child.on('error', () => this.kill('the process failed'));
      child.on('close', (code) => this.onClose(code));
      this.startReset();
    }

    startReset() {
      const session = adapter().runner.session;
      this.state = 'clearing';
      this.reset = session.createResetReader();
      this.setTimer(resetMs, () => this.kill('its reset did not complete'));
      try {
        this.child.stdin.write(`${session.clearLine()}\n`);
      } catch {
        this.kill('its reset could not be written');
      }
    }

    setTimer(ms, fn) {
      clearTimeout(this.timer);
      this.timer = setTimeout(fn, ms);
      this.timer.unref();
    }

    onStdout(chunk) {
      this.lineBuffer += this.decoder.write(chunk);
      let nl;
      while ((nl = this.lineBuffer.indexOf('\n')) !== -1) {
        const line = this.lineBuffer.slice(0, nl);
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        this.onLine(line);
        if (this.state === 'dead') return;
      }
    }

    onLine(line) {
      if (this.state === 'busy') {
        // Whole lines only: no part of a line can cross into another turn.
        this.turn.stdout.emit('data', Buffer.from(`${line}\n`, 'utf8'));
        return;
      }
      if (!line.trim()) return;
      if (this.state === 'clearing') {
        let parsed;
        try { parsed = JSON.parse(line); } catch { return; }
        let done;
        try { done = this.reset(parsed) === true; } catch { done = false; }
        if (done) {
          this.state = 'ready';
          this.setTimer(idleMs, () => this.kill('it was idle'));
        }
        return;
      }
      // Ready, between turns: nobody asked for this.
      this.kill('it wrote between turns');
    }

    take(runToken) {
      if (this.state !== 'ready') return null;
      if (!hooks.bind(this.handle.token, runToken)) return null;
      clearTimeout(this.timer);
      this.state = 'busy';
      this.turns += 1;
      /** @type {Turn} */
      let turn;
      const write = (text) => {
        if (this.turn !== turn) return;
        try {
          this.child.stdin.write(`${adapter().runner.session.userLine(text)}\n`);
        } catch {
          this.kill('the turn could not be written');
        }
      };
      turn = new Turn(this.child.pid, write, (keep, tokens) => this.endTurn(turn, keep, tokens));
      this.turn = turn;
      return turn;
    }

    endTurn(turn, keep, tokens) {
      if (this.turn !== turn) return;
      this.turn = null;
      hooks.unbind(this.handle.token);
      if (this.state === 'dead') return;
      const total = inputTotal(tokens);
      if (this.baseline === null) this.baseline = total;
      if (!keep) { this.kill('its turn did not end cleanly'); return; }
      if (this.turns >= maxTurns) { this.kill(`it served ${this.turns} turns`); return; }
      if (total > this.baseline + contextGrowth) { this.kill('its context kept growing'); return; }
      this.startReset();
    }

    kill(why) {
      if (this.state === 'dead') return;
      this.state = 'dead';
      clearTimeout(this.timer);
      hooks.unbind(this.handle.token);
      if (sessions.get(this.key) === this) sessions.delete(this.key);
      log(`warm session ended: ${why}`);
      killProcessGroup(this.child);
    }

    onClose(code) {
      const { turn } = this;
      this.kill(`its process exited (${code})`);
      this.turn = null;
      // A turn in flight ends the way a fresh run ends when its process exits.
      if (turn) turn.emit('close', code);
      Promise.resolve(hooks.close(this.handle)).catch(() => {});
      try { this.release(); } catch { /* the adapter's cleanup; logged by it */ }
    }
  }

  return {
    // Everything that decides what a run is, except the per-run MCP configuration
    // path, plus the caller.
    keyFor(command, mcpConfigPath, caller) {
      const args = command.args.map((a) => (mcpConfigPath && a === mcpConfigPath ? MCP_PLACEHOLDER : a));
      return crypto.createHash('sha256').update(JSON.stringify([args, command.env || {}, String(caller)])).digest('hex');
    },
    take(key, runToken) {
      const s = sessions.get(key);
      if (!s) return null;
      const turn = s.take(runToken);
      if (!turn) return null;
      sessions.delete(key);
      sessions.set(key, s); // most recently used
      return turn;
    },
    // Start a session for `key` in the background. `launch(mcpConfigPath)` spawns
    // the process and returns { child, release }. Never rejects.
    async spawn(key, launch) {
      if (closed || sessions.has(key)) return;
      if (sessions.size >= cap) {
        const idle = [...sessions.values()].find((s) => s.state === 'ready');
        if (!idle) return;
        idle.kill('the pool is full');
      }
      let handle;
      try {
        handle = await hooks.open();
      } catch (err) {
        log(`warm session not started: ${err.message}`);
        return;
      }
      if (closed || sessions.has(key)) { await hooks.close(handle).catch(() => {}); return; }
      let started;
      try {
        started = launch(handle.mcpConfigPath);
      } catch (err) {
        log(`warm session not started: ${err.message}`);
        await hooks.close(handle).catch(() => {});
        return;
      }
      sessions.set(key, new Session(key, handle, started.child, started.release));
    },
    size: () => sessions.size,
    states: () => [...sessions.values()].map((s) => s.state),
    shutdown() {
      closed = true;
      for (const s of [...sessions.values()]) s.kill('the add-on is stopping');
    },
  };
}

module.exports = { createSessionPool, POOL_CAP, MAX_TURNS, IDLE_MS, RESET_MS, CONTEXT_GROWTH };
