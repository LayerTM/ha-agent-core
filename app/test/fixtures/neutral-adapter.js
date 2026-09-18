'use strict';

// An engine adapter with no engine behind it, for the core's own contract tests.
// It satisfies the adapter contract and names no vendor. Its agent is
// neutral-agent.js, which plays a tape of events that are already in the core's
// neutral shape, so the decoder only filters them. It also offers `run`, a
// scripted replacement for the core's run() that HTTP-layer tests hand to
// createPromptApp, recording every call so a test can assert what was (or was
// not) dispatched. Never packed and never used outside tests.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const AGENT = path.join(__dirname, 'neutral-agent.js');
// The names the neutral adapter's branding.json would carry.
const NEUTRAL_BRANDING = Object.freeze({
  productName: 'Neutral Agent', consoleName: 'Neutral Console', agentName: 'Neutral', cliName: 'Neutral CLI', tabGlyph: '◆',
});
const HA_PREFIX = 'ha.';
const NEUTRAL_EVENTS = new Set(['init', 'fragment-start', 'fragment', 'tool-use', 'tool-result', 'result']);

// A successful run, in the shape the core consumes.
function okOutcome(overrides = {}) {
  return {
    status: 'ok',
    text: 'neutral answer',
    proposal: null,
    automation: null,
    toolsUsed: [],
    numTurns: 1,
    costUsd: 0,
    tokens: [],
    truncated: false,
    mcpFailed: false,
    mcpConnected: null,
    haTools: null,
    ...overrides,
  };
}

function errorOutcome(reason, overrides = {}) {
  return okOutcome({ status: 'error', reason, message: `neutral ${reason}`, text: '', ...overrides });
}

// A run that ends only when the core aborts it, reporting what a runner reports
// for a cancelled or expired run.
function waitForAbort(opts) {
  return new Promise((resolve) => {
    const finish = () => resolve(okOutcome({ status: 'timeout', text: '' }));
    if (opts.signal.aborted) finish();
    else opts.signal.addEventListener('abort', finish, { once: true });
  });
}

// A tape whose agent answers `text` successfully.
function okTape(text = 'neutral answer') {
  return [{ emit: { type: 'result', structured: { text, proposal: null, automation: null }, numTurns: 1, costUsd: 0 } }];
}

let tapes = null;
function tapeDir() {
  if (!tapes) {
    tapes = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-tapes-'));
    process.on('exit', () => fs.rmSync(tapes, { recursive: true, force: true }));
  }
  return tapes;
}

function createNeutralAdapter() {
  const state = {
    runs: [], // every options object handed to the scripted run
    script: [], // queued (opts) => outcome | Promise<outcome>; empty → okOutcome()
    launches: [], // every spec handed to runner.launch
    // The adapter's own per-run allocation — a real directory, which is what a
    // leak leaves behind. Kept in a STRONG map so a test can look for the leak
    // instead of waiting for a collector.
    runDirs: new Map(), // spec -> its directory, until endRun removes it
    // Every endRun call, with whether the directory was STILL THERE when the
    // call arrived. A test that only looked afterwards could not tell the call
    // from a sweep, a boot wipe or a collected decoder.
    endRuns: [], // { spec, existed }
    tapes: [], // queued tapes for the agent process; empty → okTape()
    mcpConfigs: [],
    removedSessions: [],
    limits: null,
    limitsAsked: [],
    limitsRead: [],
  };
  async function run(opts) {
    state.runs.push(opts);
    const step = state.script.shift();
    return step ? step(opts) : okOutcome();
  }
  const adapter = {
    apiVersion: 5,
    descriptor: {
      engine: 'neutral',
      // `neutral-agent 1.2.3 (build)` → `1.2.3`
      parseVersion(stdout) {
        const match = /^neutral-agent (\S+)/.exec(stdout);
        return match ? match[1] : null;
      },
    },
    runner: {
      bin: '/nonexistent/neutral-agent',
      // The agent is a node script: the core's `bin` is node, the script and
      // its tape are the arguments. The key variable shows what the adapter may
      // pass on; a Supervisor token it tries to pass must not arrive.
      launch(spec, { env }) {
        state.launches.push(spec);
        // Allocate for this run where a real adapter does: in launch, which the
        // core calls before spawning, so a spawn failure leaks it unless the
        // core says the run ended.
        const runDir = path.join(tapeDir(), `run-${state.launches.length}`);
        fs.mkdirSync(runDir, { recursive: true });
        state.runDirs.set(spec, runDir);
        const tape = state.tapes.shift() || okTape();
        const file = path.join(tapeDir(), `tape-${state.launches.length}.json`);
        fs.writeFileSync(file, JSON.stringify(tape));
        return {
          args: [AGENT, file],
          env: {
            ...(env.NEUTRAL_AGENT_KEY ? { NEUTRAL_AGENT_KEY: env.NEUTRAL_AGENT_KEY } : {}),
            ...(env.NEUTRAL_LEAK_TEST ? { SUPERVISOR_TOKEN: 'leak', TERM: 'xterm', PATH: '/leak' } : {}),
          },
        };
      },
      // The contract's optional terminal call: free what launch allocated for
      // this run. Recorded before the removal, so the assertion is about the
      // call and not about the final state of the disk.
      endRun(spec) {
        const dir = state.runDirs.get(spec);
        state.endRuns.push({ spec, existed: Boolean(dir) && fs.existsSync(dir) });
        if (!dir) return;
        state.runDirs.delete(spec);
        fs.rmSync(dir, { recursive: true, force: true });
      },
      createDecoder() {
        return (event) => {
          if (event && event.type === 'many' && Array.isArray(event.events)) return event.events;
          return event && NEUTRAL_EVENTS.has(event.type) ? [event] : [];
        };
      },
      toolName(basename) { return `${HA_PREFIX}${basename}`; },
      // `ha.GetLiveContext` and `ha.homeassistant__GetLiveContext` → `GetLiveContext`
      toolBasename(name) {
        if (!name.startsWith(HA_PREFIX) || name.length === HA_PREFIX.length) return null;
        return name.slice(HA_PREFIX.length).split('__').pop();
      },
    },
    prompt: {
      // Whatever a test puts in state.limits: null (no credential), or
      // { mode, key, entries } where `entries` may be a function of the fetch.
      limitsSource(credentials) {
        state.limitsAsked.push(credentials);
        const cfg = state.limits;
        if (!cfg) return null;
        if (cfg.throws) throw new Error('neutral limits source failed');
        if (!('entries' in cfg)) return { mode: cfg.mode, key: cfg.key };
        return {
          mode: cfg.mode,
          key: cfg.key,
          async read(fetch) {
            state.limitsRead.push(fetch);
            return typeof cfg.entries === 'function' ? cfg.entries(fetch) : cfg.entries;
          },
        };
      },
      secretPatterns: [/\bneutral-key-[A-Za-z0-9]{8,}/g],
      authConfigured() { return true; },
      async writeMcpConfig({ dir, url, bearer }) {
        state.mcpConfigs.push({ dir, url, bearer });
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, 'neutral-mcp.json');
        if (!url || !bearer) {
          await fsp.rm(file, { force: true });
          return null;
        }
        await fsp.writeFile(file, JSON.stringify({ url }), { mode: 0o600 });
        return file;
      },
      hasAuditHook(raw) { return raw === 'neutral-audit-hook'; },
      async removeSavedSessions(homeDir, workDir) {
        state.removedSessions.push({ homeDir, workDir });
        return 0;
      },
      credentials() { return { apiKey: '', oauthToken: '' }; },
      secretValues({ options, optionString }) {
        return { options: [optionString(options, 'neutral_key')], env: [process.env.NEUTRAL_AGENT_KEY] };
      },
    },
    console: {
      bin: '/nonexistent/neutral-agent',
      updateCommand: '/nonexistent/neutral-agent-update',
      windowName: 'agent',
      launcher: '/nonexistent/neutral-agent-launch',
    },
  };
  return { adapter, state, run, branding: NEUTRAL_BRANDING };
}

module.exports = { createNeutralAdapter, okOutcome, errorOutcome, waitForAbort, okTape, AGENT, NEUTRAL_BRANDING };
