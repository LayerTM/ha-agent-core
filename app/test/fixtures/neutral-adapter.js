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
    tapes: [], // queued tapes for the agent process; empty → okTape()
    mcpConfigs: [],
    removedSessions: [],
  };
  async function run(opts) {
    state.runs.push(opts);
    const step = state.script.shift();
    return step ? step(opts) : okOutcome();
  }
  const adapter = {
    apiVersion: 3,
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
      limitsCredential() { return ''; },
      async fetchLimits() { throw new Error('neutral adapter has no account limits'); },
      limitEntry(item) { return item; },
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
  return { adapter, state, run };
}

module.exports = { createNeutralAdapter, okOutcome, errorOutcome, waitForAbort, okTape, AGENT };
