'use strict';

// An engine adapter with no engine behind it, for the core's own contract tests.
// It satisfies the adapter contract, names no vendor, starts no process, and
// records every call the core makes, so a test can assert what was (or was not)
// dispatched. Never packed and never used outside tests.

const fsp = require('node:fs/promises');
const path = require('node:path');

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

function createNeutralAdapter({ timeoutMs = 5000 } = {}) {
  const state = {
    runs: [], // every options object handed to runner.run
    script: [], // queued (opts) => outcome | Promise<outcome>; empty → okOutcome()
    shutdowns: 0,
    mcpConfigs: [],
    removedSessions: [],
  };
  const adapter = {
    apiVersion: 1,
    runner: {
      TIMEOUT_MS: timeoutMs,
      async run(opts) {
        state.runs.push(opts);
        const step = state.script.shift();
        return step ? step(opts) : okOutcome();
      },
      shutdown() { state.shutdowns += 1; },
      safeLangTag(raw) {
        return typeof raw === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(raw) ? raw : '';
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
  return { adapter, state };
}

module.exports = { createNeutralAdapter, okOutcome, errorOutcome, waitForAbort };
