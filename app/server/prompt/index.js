'use strict';

// Bootstrap for the prompt server (the add-on side of the claude_ha bridge):
// load options, provision the bearer token, write the scoped HA MCP config,
// bind 0.0.0.0:<port> (internal docker network only — the port is NOT in the
// add-on's `ports:`, so it is never published to the host), then announce
// host/port/token to the Supervisor discovery API for the integration.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPromptApp } = require('./server');
const { shutdown: shutdownRuns } = require('./run');
const { createAuditSink } = require('./audit');
const { buildRedactor } = require('./security');
const { adapter } = require('../adapter-contract');
const { resolveCoreTarget } = require('./core-target');
const { startCoreRelay } = require('./core-relay');
const { boundAddress } = require('../listen');

const PORT = Number(process.env.CLAUDE_PROMPT_PORT || 8126);
// Every IPv4 interface unless one address is named (the tests name the one they use).
const HOST = process.env.CLAUDE_PROMPT_HOST || '0.0.0.0';
const DEV = process.env.CLAUDE_PROMPT_DEV === '1';
const DATA_DIR = process.env.CLAUDE_PROMPT_DATA || '/data';
const OPTIONS_FILE = process.env.CLAUDE_PROMPT_OPTIONS || '/data/options.json';
const USAGE_BIN = process.env.CLAUDE_PROMPT_USAGE_BIN || '/usr/local/bin/ha-usage';
// Dev/test escape hatch only. In the add-on the startup script unsets it after
// applying user environment_vars, so it can never be set from the config — the
// Core address is derived (see core-target.js), never supplied.
const HA_MCP_URL_OVERRIDE = process.env.CLAUDE_PROMPT_HA_MCP_URL || '';
const DISCOVERY_SERVICE = 'claude_ha';
// Where chat runs work. Stated once: the removal of the sessions earlier
// versions saved derives Claude's transcript folder from it.
const PROMPT_DIR = path.join(DATA_DIR, 'claude-prompt');
const WORK_DIR = path.join(PROMPT_DIR, 'work');
// One directory per run in flight, removed with the run. Never inherited: a
// restart wipes the lot, because a bearer from before it is already revoked.
const RUNS_DIR = path.join(PROMPT_DIR, 'runs');

function log(msg) {
  console.log(`[prompt] ${msg}`);
}

function readOptions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function optionString(options, key) {
  const value = options[key];
  return typeof value === 'string' ? value.trim() : '';
}

// Bearer token: the user-set `api_token` option wins; otherwise a 32-byte
// url-safe token is generated once and persisted across restarts/updates.
async function loadToken(options) {
  const configured = optionString(options, 'api_token');
  if (configured) return configured;
  const file = path.join(DATA_DIR, 'claude-prompt-token');
  try {
    const existing = (await fsp.readFile(file, 'utf8')).trim();
    if (existing.length >= 16) return existing;
  } catch { /* first boot */ }
  const token = crypto.randomBytes(32).toString('base64url');
  await fsp.writeFile(file, `${token}\n`, { mode: 0o600 });
  log('generated new prompt-API token');
  return token;
}

// The MCP config the spawned agent reads, written by the adapter into the
// prompt server's private 0700 directory (0600). It points at the loopback relay
// and carries the per-boot RELAY token — not the Home Assistant one, which stays
// in this process (see core-relay.js). Never the Supervisor token. Resolves to
// the file path, or null (file removed) when there is no relay.
function writeMcpConfig(dir, url, bearer) {
  return adapter().prompt.writeMcpConfig({ dir, url, bearer });
}

// Transcripts that earlier versions let chat runs save are removed at every
// start. Resolves to the number of transcripts removed.
function removeSavedPromptSessions(homeDir, workDir) {
  return adapter().prompt.removeSavedSessions(homeDir, workDir);
}

async function ensureWorkDir() {
  await fsp.mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
  return WORK_DIR;
}

function supervisorRequest(pathname, options = {}) {
  return fetch(`http://supervisor${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
}

// Announce {host, port, token} to the Supervisor so the claude_ha integration
// auto-configures with zero user input. Re-sent on every boot (the Supervisor
// updates the existing message). Failure is non-fatal: the integration can
// still fall back to the `api_token` option.
async function announceDiscovery(token) {
  if (DEV || !process.env.SUPERVISOR_TOKEN) {
    log('discovery skipped (dev mode or no SUPERVISOR_TOKEN)');
    return;
  }
  const delays = [0, 5000, 15000, 30000];
  for (const delay of delays) {
    if (delay) await new Promise((r) => { setTimeout(r, delay); });
    try {
      const info = await supervisorRequest('/addons/self/info');
      if (!info.ok) throw new Error(`self/info HTTP ${info.status}`);
      // Supervisor JSON is untyped (Response.json() is `unknown`); read the one
      // field we need off an `any` view.
      const host = /** @type {any} */ (await info.json()).data?.hostname;
      if (!host) throw new Error('no hostname in self/info');
      const res = await supervisorRequest('/discovery', {
        method: 'POST',
        body: JSON.stringify({
          service: DISCOVERY_SERVICE,
          config: { host, port: PORT, token },
        }),
      });
      if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
      log(`discovery announced (${host}:${PORT})`);
      return;
    } catch (err) {
      log(`discovery attempt failed: ${err.message}`);
    }
  }
  log('discovery failed — the claude_ha integration can still use the api_token option');
}

// Start the prompt server. Returns a shutdown function; never throws in a way
// that should take the console down — the caller catches and logs.
async function start() {
  // Before anything else, so the transcripts are gone whether or not the
  // prompt API is switched on.
  try {
    const removed = await removeSavedPromptSessions(process.env.HOME || '/data/home', WORK_DIR);
    if (removed) log(`removed ${removed} saved chat session transcript(s) left by earlier versions`);
  } catch (err) {
    log(`could not remove saved chat sessions: ${err.message}`);
  }

  const options = readOptions();
  if (options.prompt_api === false) {
    log('disabled via prompt_api option');
    return () => {};
  }
  // Every Home Assistant action a chat request takes is recorded by the relay it
  // must pass (core-relay.js), so the answer to "will this run's actions be
  // recorded?" is the core's own and the same for every engine. It used to be
  // the engine's answer about itself — whether its settings carried an audit
  // hook — which an engine that cannot run hooks could not give truthfully, and
  // which nothing behind the flag ever checked.
  const claudeSettings = process.env.CLAUDE_PROMPT_SETTINGS || '';

  // A USD cap can only be kept by an engine that reports what a run cost; for any
  // other, the prompt API does not start rather than claim to enforce it.
  const dailyBudgetUsd = Number(options.chat_daily_budget_usd) || 0;
  if (dailyBudgetUsd > 0 && adapter().descriptor.reportsCost !== true) {
    log(`ERROR: chat_daily_budget_usd is ${dailyBudgetUsd}, but ${adapter().descriptor.engine} does not report`
      + ' what a request costs — the prompt API is not started; set the budget to 0');
    return () => {};
  }

  const token = await loadToken(options);
  // A dedicated restricted-user LLAT (prompt_ha_token) is preferred; the
  // general ha_token is the zero-extra-config fallback. Assist exposure still
  // caps what either can touch through the MCP server.
  const haToken = optionString(options, 'prompt_ha_token') || optionString(options, 'ha_token');

  // Ask the Supervisor where Core actually listens, then put a loopback relay in
  // front of it. Everything downstream — the spawned Claude's MCP client and the
  // camera-snapshot fetch — talks plain HTTP to the relay and never sees the HA
  // token or has to reason about Core's TLS. (ClaudeInHA#47)
  const auditFile = path.join(DATA_DIR, 'claude-audit.log');
  // The sink knows whether the record is still being kept; the server asks it
  // before it lets a request act on the home. Asked once here first, because a
  // read-only or unwritable /data is a boot fact and a chat request is the wrong
  // way for a user to discover one. The probe writes no byte into the log.
  const auditSink = createAuditSink(auditFile);
  const audit = (line) => auditSink.append(line);
  if (await auditSink.probe()) log(`audit log ${auditFile} is writable`);
  else log(`audit log ${auditFile} cannot be written (${auditSink.state().code}) — Home Assistant actions are not being recorded, so acting is refused until a write succeeds`);

  const coreTarget = await resolveCoreTarget();
  log(`core at ${coreTarget.origin} (${coreTarget.source})`);
  let relay = null;
  if (haToken) {
    // Every Home Assistant call a run makes is written to the same log, in the
    // same format, as the audit hook writes for a console run — the relay is the
    // one place that sees the call, its arguments and Core's answer for EVERY
    // engine, with hooks or without.
    relay = await startCoreRelay({ coreOrigin: coreTarget.origin, haToken, log, record: audit });
    log(`core relay on 127.0.0.1:${relay.port}`);
  }

  // Whether Home Assistant is configured is a boot fact: is there a relay, hence
  // an MCP server to point a run at? The configuration FILE is not a boot fact —
  // it belongs to one run and does not outlive it (see beginRun below).
  const haConfigured = Boolean(relay);
  // Remove the one an older version wrote into the shared directory, and any run
  // directory a crash left behind: a restart inherits no bearer and no file.
  await writeMcpConfig(PROMPT_DIR, '', '');
  await fsp.rm(RUNS_DIR, { recursive: true, force: true });

  // One run's identity and the two things that carry it: the bearer the relay
  // knows it by, and the MCP configuration its agent reads. Both are made here
  // and destroyed by endRun, whatever ends the run.
  const beginRun = async (runId) => {
    if (!relay) return { token: '', mcpConfigPath: null, dir: null };
    const bearer = relay.issue(runId);
    const dir = path.join(RUNS_DIR, runId);
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const configPath = await writeMcpConfig(dir, HA_MCP_URL_OVERRIDE || `${relay.url}/api/mcp`, bearer);
      return { token: bearer, mcpConfigPath: configPath, dir };
    } catch (err) {
      relay.revoke(bearer);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  };
  const endRun = async (run) => {
    if (!run) return;
    if (relay && run.token) relay.revoke(run.token);
    if (run.dir) await fsp.rm(run.dir, { recursive: true, force: true }).catch(() => {});
  };
  const workDir = await ensureWorkDir();

  // The engine's credentials, in the order the redactor has always received them:
  // its option values after the Home Assistant ones, its environment values last.
  const secrets = adapter().prompt.secretValues({ options, env: process.env, optionString });
  const redact = buildRedactor([
    token,
    haToken,
    optionString(options, 'ha_token'),
    ...secrets.options,
    process.env.SUPERVISOR_TOKEN,
    ...secrets.env,
  ], adapter().prompt.secretPatterns || []);

  const app = createPromptApp({
    token,
    // The agent executable: the adapter's, unless the environment names another.
    claudeBin: process.env.CLAUDE_PROMPT_BIN || adapter().runner.bin,
    claudeSettings,
    usageBin: USAGE_BIN,
    haConfigured,
    beginRun,
    endRun,
    // Whether the audit log is still being written, asked at the moment a
    // request is about to act: an action that cannot be recorded is refused.
    auditState: () => auditSink.state(),
    // A dedicated chat model (e.g. a faster/cheaper one) is preferred; fall back
    // to the console's model override, then the Claude default.
    model: optionString(options, 'chat_model') || optionString(options, 'model'),
    // Optional faster/cheaper model for spoken (voice) turns — replies are short
    // there, so latency matters more than raw capability. Empty → voice uses the
    // same `model` as text (no change).
    voiceModel: optionString(options, 'chat_model_voice'),
    // Optional models per request type; empty → the chat model above (no change).
    writeModel: optionString(options, 'chat_model_write'),
    cameraModel: optionString(options, 'chat_model_camera'),
    dailyBudgetUsd,
    // Camera snapshots (vision) go through the same relay, so the HA token and
    // the Core TLS decision live in exactly one place.
    coreRelayUrl: relay ? relay.url : '',
    // For /api/account_limits: which credential the account has, in the same
    // order everything else here uses (option first, then environment). The
    // interactive-login case has neither and is read from HOME at call time.
    ...adapter().prompt.credentials({ options, env: process.env, optionString }),
    homeDir: process.env.HOME || '/data/home',
    workDir,
    addonVersion: process.env.ADDON_VERSION || 'unknown',
    redact,
    audit,
    // Durable state (budget spend + chat-health window) lives alongside the MCP
    // config in the existing 0700 claude-prompt dir, so it survives restarts.
    stateDir: PROMPT_DIR,
    // The /data root, where the separate cc-alerts service writes alerts-state.json.
    // The server reads that file to publish the active-alerts set on /api/status.
    dataDir: DATA_DIR,
    // Whether proactive alerts are on — /api/status publishes a set only then.
    proactiveAlerts: options.proactive_alerts === true,
  });

  const server = http.createServer(app);
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }));
  // Keep a persistent error handler so a post-bind socket error is logged, not
  // thrown as an uncaught exception that would take the shared console down.
  server.on('error', (err) => log(`server error: ${err.message}`));
  log(`prompt server listening on ${boundAddress(server)} (ha_mcp: ${haConfigured ? 'configured' : 'absent'})`);

  announceDiscovery(token).catch((err) => log(`discovery error: ${err.message}`));

  return function shutdown() {
    shutdownRuns();
    if (relay) relay.close();
    server.close();
    server.closeAllConnections();
  };
}

module.exports = { start, removeSavedPromptSessions };
