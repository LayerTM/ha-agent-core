'use strict';

// A loopback relay in front of Home Assistant Core.
//
// Why it exists, in one sentence: it is the single place that holds the Home
// Assistant token and decides how to reach Core, so nothing else has to.
//
// Two problems it solves at once.
//
// 1. TLS on Core. When Core terminates TLS itself, the certificate is issued for
//    the name users type from outside, while the add-on reaches Core over the
//    internal docker network as `homeassistant`. The names cannot match, by
//    construction — so certificate verification on this hop can never pass and
//    protects nothing. The hop does not leave the host. Home Assistant's own
//    Supervisor reached the same conclusion: it talks to Core over a unix socket
//    where it can, and over the network it connects by IP with verification off
//    (`supervisor/homeassistant/api.py` — `api_authority`, and `ssl=False` on its
//    Core requests). We do the same, and only ever to the address WE derive from
//    the Supervisor — never to a user-supplied host, so there is no destination
//    an attacker could point the token at.
//
//    The relay is what makes that possible at all for MCP: the TLS peer there is
//    the bundled `claude` CLI, not our code, and the MCP config we write it
//    carries only {type, url, headers} — there is no TLS knob to set. Pointing
//    the CLI at plain HTTP on loopback moves the TLS decision back to us.
//
// 2. The child process no longer holds a Home Assistant credential. Before, the
//    spawned `claude` read the LLAT out of its MCP config. Now it gets a
//    per-boot relay token that is useless anywhere else, and the LLAT stays in
//    this process.
//
// The relay is deliberately narrow: loopback only, one bearer token, and an
// exact allowlist of the two paths the add-on actually uses. On the MCP path it
// also decides which JSON-RPC methods pass, in both directions (mcp-filter.js).

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const {
  MAX_BODY_BYTES, judgeClientBody, filterServerJson, createSseFilter,
} = require('./mcp-filter');
const { haBasename } = require('./ha-tool-names');
const { createStateNames } = require('./state-names');

// Exactly what the add-on needs, and nothing else.
const MCP_PATH = '/api/mcp';
const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);
const CAMERA_PATH_RE = /^\/api\/camera_proxy\/[a-z_]+\.[a-z0-9_]+$/;
const CAMERA_PREFIX = '/api/camera_proxy/';

// The record of one call, in the shape the audit hook writes for a console run,
// so one log holds one format: `<tool> run=<id><mark>: <arguments>`. The caps are
// the hook's, in bytes, because the arguments are the model's text: capped so one
// dashboard configuration cannot fill the log, and stripped of control characters
// so nothing in them can start a line of its own.
// eslint-disable-next-line no-control-regex -- these are exactly what must go
const CONTROL = /[\u0000-\u001f\u007f]/g;
const ARGS_CAP = 300;
const LINE_CAP = 1000;
const DRY_RUN_TEXT = /"dry_run"\s*:\s*true/;
// The one tool a lookup calls, and how long Core has to answer one.
const LIVE_CONTEXT = 'GetLiveContext';
const LOOKUP_TIMEOUT_MS = 10000;

// What is read of Home Assistant's answers. MAX_BODY_BYTES bounds what an agent
// may send; these bound what the house may hold, and a large house is not an abuse
// of anything.
//
// MAX_ANSWERS_HELD_BYTES is one budget for the whole process, shared by every
// answer being read or delivered at the same moment, so that two runs cannot
// multiply it. An answer that would pass it is refused as too large, at once. A
// JSON answer costs up to about seven times its bytes while it is parsed (the
// bytes, their text, what that parses to), so this keeps the relay near 160 MiB at
// its worst on a small host. A tool answer carries only what is exposed to Assist.
//
// MAX_STATES_BYTES is how much of one states list is read at all. The list is not
// held (state-names.js), so it can pass the budget's size. /api/states carries
// every state whether exposed or not: 6,300 states are about 4 MiB, so this is room
// for about 100,000.
const MIB = 1024 * 1024;
const MAX_ANSWERS_HELD_BYTES = 16 * MIB;
const MAX_STATES_BYTES = 64 * MIB;
// How long an agent has to read one answer it holds a share for, however busy its
// socket looks. Over loopback the largest answer takes well under a second.
const DELIVERY_DEADLINE_MS = 60000;
// How long a request stays open once its agent has left, for a tool still running.
const ABANDONED_REQUEST_MS = 60 * 60 * 1000;
const answerTooLarge = (what) => `Home Assistant's answer to ${what} is too large (over ${MAX_ANSWERS_HELD_BYTES / MIB} MiB, counting answers being read at the same time)`;
const statesTooLarge = () => `Home Assistant's states list is too large (over ${MAX_STATES_BYTES / MIB} MiB)`;

let answerBytesHeld = 0;
// One answer's share of the budget. `take` is false when there is no room for that
// many more bytes, and then nothing is taken; `release` gives back all of it, may
// be called any number of times, and is final: a released share takes nothing more,
// so no order of events can leave bytes charged with nobody left to give them back.
function answerHold() {
  let mine = 0;
  let released = false;
  return {
    take(bytes) {
      if (released || answerBytesHeld + bytes > MAX_ANSWERS_HELD_BYTES) return false;
      answerBytesHeld += bytes;
      mine += bytes;
      return true;
    },
    release() {
      released = true;
      answerBytesHeld -= mine;
      mine = 0;
    },
  };
}

// Calls `onStall` when `stream` has delivered nothing for `ms`, until it closes or
// ends. A timer of its own, not the socket's: that socket goes back to the pool.
function watchStall(stream, ms, onStall) {
  const timer = setTimeout(onStall, ms);
  timer.unref();
  stream.on('data', () => timer.refresh());
  const stop = () => clearTimeout(timer);
  stream.once('end', stop);
  stream.once('close', stop);
}

// The relay's own question to Home Assistant about the token: an MCP
// `initialize`, which every MCP server answers and which acts on nothing.
const AUTH_PROBE = {
  jsonrpc: '2.0',
  id: 'auth-probe',
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ha-agent-core', version: 'auth-probe' } },
};

// What one Home Assistant answer on the MCP path says about the token, or null
// when it says nothing about it. 401 and 403 are both a refusal of THIS token:
// Home Assistant answers 401 for a token it does not know, and for a valid
// non-administrator token when its Model Context Protocol Server requires an
// administrator (401 up to 2026.10.1, 403 after). Any 2xx means it was accepted.
function authFromStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'unauthorized';
  return null;
}

// What the person running the add-on can do about a refused token, said once
// for every place that reports one.
function refusedTokenHint(status) {
  return `refused the add-on's Home Assistant token (${status}) — check the token in the add-on's `
    + 'configuration, and that its user is an administrator if the Model Context Protocol Server '
    + 'requires one';
}

function capBytes(text, limit) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  return buf.subarray(0, limit).toString('utf8').replace(/\uFFFD+$/, '');
}

// Only an explicit dry_run makes a line a preview — in the arguments, in the
// answer, or in the text the answer carries. Anything unproven is a change.
// (Same polarity, and the same three places, as cc-hook-audit.)
function isDryRun(call, answer) {
  if (call.args && typeof call.args === 'object' && call.args.dry_run === true) return true;
  const result = answer && answer.result;
  if (typeof result === 'string') return DRY_RUN_TEXT.test(result);
  if (result && typeof result === 'object') {
    if (result.dry_run === true) return true;
    const texts = Array.isArray(result.content)
      ? result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ')
      : '';
    return DRY_RUN_TEXT.test(texts);
  }
  return false;
}

function describeCall(call, mark) {
  let args;
  try {
    args = JSON.stringify(call.args === undefined ? {} : call.args);
  } catch {
    args = '(arguments that are not JSON)';
  }
  const line = `${call.name || '(unnamed tool)'} run=${call.runId}${mark}: ${capBytes(args, ARGS_CAP)}`;
  return capBytes(line.replace(CONTROL, ' '), LINE_CAP);
}

// The text a tool answer carries, its content parts joined.
function toolText(result) {
  return Array.isArray(result && result.content)
    ? result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('')
    : '';
}

// Why Home Assistant's answer to one action is a failure, or null when it is
// not. An intent tool answers with the intent's response as JSON text. An
// intent that raised is marked isError and carries the reason, as text or as
// {error}; one that ran but could not act on a target names it in
// `data.failed`; one that could not run at all is `response_type: "error"`.
function actionError({ status, json }) {
  if (status !== 200 || !json || typeof json !== 'object') return `Home Assistant answered ${status}`;
  if (json.error) {
    return json.error && typeof json.error.message === 'string'
      ? json.error.message : 'Home Assistant answered with an error';
  }
  const { result } = json;
  if (!result || typeof result !== 'object') return 'Home Assistant answered without a result';
  const text = toolText(result);
  let answer;
  try { answer = JSON.parse(text); } catch { answer = null; }
  if (result.isError === true) {
    if (answer && typeof answer === 'object' && typeof answer.error === 'string') return answer.error;
    return text || 'Home Assistant answered with an error';
  }
  if (!answer || typeof answer !== 'object') return null;
  if (answer.response_type === 'error') {
    const speech = answer.speech && answer.speech.plain && answer.speech.plain.speech;
    return typeof speech === 'string' && speech ? speech : 'Home Assistant could not carry out the intent';
  }
  const failed = answer.data && Array.isArray(answer.data.failed) ? answer.data.failed : [];
  if (failed.length > 0) {
    const names = failed.map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter(Boolean);
    return `Home Assistant could not act on ${names.length > 0 ? names.join(', ') : 'the target'}`;
  }
  return null;
}

// Headers copied client -> Core. `authorization` is deliberately absent: it is
// replaced, never forwarded. Neither are `content-length` and
// `transfer-encoding`: the relay sets the length of the one body it sends. The
// MCP set matches what the Supervisor's own proxy forwards for streamable HTTP.
const FORWARD_TO_CORE = new Set([
  'accept',
  'accept-language',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

// Headers copied Core -> client. Session id must survive or MCP cannot resume.
const FORWARD_TO_CLIENT = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'mcp-session-id',
]);

// What THIS run may reach, by method and path. The MCP door is the same for every
// run — which tools it may call through it is judged from the body. The camera
// door is not: a camera read is a Home Assistant action of its own, it carries no
// tool name, and the bearer that opens it lives in the agent's own MCP
// configuration, so a run given one camera must not be able to read another. The
// run's entity is the whole permission: no entity, no camera path.
function allowed(method, pathname, entry) {
  if (pathname === MCP_PATH) return MCP_METHODS.has(method);
  if (method !== 'GET' || !CAMERA_PATH_RE.test(pathname)) return false;
  return entry.cameras.has(pathname.slice(CAMERA_PREFIX.length));
}

// The whole body of a message, or null the moment `admit` turns a chunk's size
// down. `done` is called once; what still arrives after a refusal is dropped.
function readAdmitted(stream, admit, done) {
  let chunks = [];
  stream.on('data', (chunk) => {
    if (chunks === null) return;
    if (admit(chunk.length)) {
      chunks.push(chunk);
      return;
    }
    chunks = null;
    done(null);
  });
  stream.on('end', () => {
    if (chunks === null) return;
    const whole = Buffer.concat(chunks);
    chunks = null;
    done(whole);
  });
}

// What an agent sends, up to `limit`.
function readBody(stream, limit, done) {
  let size = 0;
  readAdmitted(stream, (bytes) => {
    size += bytes;
    return size <= limit;
  }, done);
}

// A JSON answer from Home Assistant, as coreRequest gives it. It holds its share
// until it is parsed; one that passes the budget, or breaks, gives it back as its
// connection closes.
function readJsonAnswer(stream, done) {
  const hold = answerHold();
  stream.once('close', hold.release);
  readAdmitted(stream, hold.take, (raw) => {
    let json;
    try { json = raw === null ? null : JSON.parse(raw.toString('utf8')); } catch { json = null; }
    hold.release();
    done({ json, tooLarge: raw === null });
    if (raw === null) stream.destroy();
  });
}

// The states list the same way, reduced to what a lookup reads as it arrives.
function readStatesAnswer(stream, done) {
  const names = createStateNames();
  const hold = answerHold();
  stream.once('close', hold.release);
  let size = 0;
  let settled = false;
  const refuse = (why) => {
    settled = true;
    hold.release();
    done({ json: null, tooLarge: true, why });
    stream.destroy();
  };
  stream.on('data', (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_STATES_BYTES) {
      refuse(statesTooLarge);
      return;
    }
    const before = names.held();
    names.push(chunk);
    if (!hold.take(names.held() - before)) refuse(() => answerTooLarge('the states list'));
  });
  stream.on('end', () => {
    if (settled) return;
    settled = true;
    hold.release();
    done({ json: names.end(), tooLarge: false });
  });
}

// Whether a request says it has a body. Only POST /api/mcp may, and that body
// is read and judged; any other request with one is refused.
function hasBody(req) {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && length !== '0';
}

function deny(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Start the relay.
 *
 * @param {object} opts
 * @param {string} opts.coreOrigin  Origin derived from the Supervisor (never user input).
 * @param {string} opts.haToken     The Home Assistant LLAT. Stays in this process.
 * @param {(msg: string) => void} [opts.log]
 * @param {(line: string) => void} [opts.record]  One audit line per tool call.
 * @param {number} [opts.authProbeEveryMs]  Probe the token at start and then this
 *   often; 0 (the default) probes only when asked.
 * @param {number} [opts.deliveryDeadlineMs]  How long an agent has to read one answer.
 * @param {number} [opts.abandonedRequestMs]  How long a tool may outlive the agent that called it.
 * @returns {Promise<{
 *   url: string, port: number, issue: (runId: string) => string,
 *   revoke: (token: string) => void, close: () => void,
 *   mcpAuth: () => null|'ok'|'unauthorized'|'unreachable',
 *   probeAuth: () => Promise<null|'ok'|'unauthorized'|'unreachable'>,
 *   tokenRefusal: (runId: string) => null|number,
 *   lookup: (runId: string) => {
 *     live: (name: string) => Promise<{ok: boolean, text: string}>,
 *     liveDomain: (domain: string) => Promise<{ok: boolean, text: string}>,
 *     states: () => Promise<Array<{entity_id: string, attributes?: object}>>,
 *   },
 *   act: (runId: string) => (basename: string, args: object) => Promise<{ok: boolean, error?: string}>,
 * }>}
 *
 * The bearer is per RUN, not per boot: `issue(runId)` mints one and `revoke`
 * takes it back, so every request the relay serves names the run that made it.
 * One relay serves them all, and the core permits two runs at once, so a bearer
 * is the only thing that can tell them apart without asking Home Assistant for
 * something Home Assistant never promised.
 */
async function startCoreRelay({
  coreOrigin, haToken, log = () => {}, record = () => {}, authProbeEveryMs = 0,
  deliveryDeadlineMs = DELIVERY_DEADLINE_MS,
  abandonedRequestMs = ABANDONED_REQUEST_MS,
}) {
  // Whether Home Assistant accepts the add-on's token on the MCP path, from the
  // latest answer that said so: 'ok', 'unauthorized', 'unreachable' (a probe got
  // no answer about the token), or null before anything has answered. Every
  // answer on the MCP path writes it — a run's, a lookup's and the relay's own
  // probe — so health does not depend on a chat having happened, and a run that
  // is refused is reported by the refusal itself. A change is logged; a repeat
  // is not.
  /** @type {null|'ok'|'unauthorized'|'unreachable'} */
  let mcpAuth = null;
  // How many answers about the token have arrived. A probe that ends without
  // one may say 'unreachable' only if none arrived while it was in flight:
  // otherwise a late failure of the probe would overwrite a newer, real answer.
  let tokenAnswers = 0;
  // The runs whose bearer Home Assistant refused, and with what status. Kept per
  // run because the bearer is per run: the server asks about the run it is
  // ending, and another run's refusal says nothing about it. The mark ends with
  // the run (revoke) so it can never outlive the bearer it describes.
  /** @type {Map<string, number>} */
  const refusedRuns = new Map();
  function noteMcpAuth(next, why) {
    if (next === mcpAuth) return;
    mcpAuth = next;
    log(`home assistant mcp token: ${next} (${why})`);
  }
  function observeMcpAnswer(status, why) {
    const next = authFromStatus(status);
    if (next === null) return;
    tokenAnswers += 1;
    noteMcpAuth(next, `${why} answered ${status}`);
  }
  // What a bearer IS: the run it belongs to and what that run may do — the Home
  // Assistant tool basenames it may call and the camera entities it may read (a
  // request names at most one). Both are given when the bearer is minted, so
  // there is no moment in which a live bearer means less than it will mean later.
  // An entry with an empty set may call nothing and read nothing: unset refuses.
  /** @type {Map<string, {runId: string, basenames: Set<string>, cameras: Set<string>}>} */
  const runs = new Map();
  // Calls a run has sent and Home Assistant has not answered yet, per run rather
  // than per request: the answer may come back on this POST or on the run's own
  // event stream, and either resolves it.
  /** @type {Map<string, Map<string, {id: unknown, name: string, args: unknown, runId: string}>>} */
  const awaiting = new Map();

  // The end of a run's life settles the calls it never got an answer to. A call
  // Home Assistant never answered is still something the run asked for, and
  // silence is not a record of it — the same reason a failed call is recorded
  // rather than dropped.
  //
  // It lives here, once, because it is a property of a run ENDING and not of the
  // particular way it ended: `revoke` ends one run, `close` ends the server and
  // with it every run still open. `close` used to clear the tokens and leave
  // `awaiting` untouched, so a shutdown with calls in the air erased them, and
  // the reader of the log saw silence where Home Assistant had simply not
  // answered yet. A third ending must come through here too.
  function settleUnanswered(runId) {
    const pending = awaiting.get(runId);
    awaiting.delete(runId);
    if (!pending) return;
    for (const call of pending.values()) record(describeCall(call, ' (no answer)'));
  }

  function observerFor(runId) {
    return (message) => {
      if (!message || typeof message !== 'object' || !('id' in message) || message.id === null) return;
      const pending = awaiting.get(runId);
      const call = pending && pending.get(String(message.id));
      if (!call) return;
      pending.delete(String(message.id));
      const failed = message.error !== undefined
        || (message.result && typeof message.result === 'object' && message.result.isError === true);
      record(describeCall(call, isDryRun(call, message) ? ' (dry-run)' : (failed ? ' (failed)' : '')));
    };
  }
  const target = new URL(coreOrigin);
  const secure = target.protocol === 'https:';
  const transport = secure ? https : http;

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      deny(res, 400, 'bad request');
      return;
    }

    const auth = req.headers.authorization || '';
    // Constant-time comparison is not warranted here: the token never leaves
    // loopback, and an attacker able to time it is already inside the container.
    // A lookup rather than a comparison, because the answer is WHICH run this is,
    // not merely whether it may pass; an unknown bearer is refused as before.
    const entry = auth.startsWith('Bearer ') ? runs.get(auth.slice(7)) : undefined;
    if (entry === undefined) {
      // A refusal says so. Until this line the relay refused in silence, and the
      // silence arrived by the same path as "nothing happened": the run still
      // answered 200 with no tool call, the audit recorded only successful calls,
      // and a rejected bearer was indistinguishable from an engine that chose not
      // to call anything. What is logged is everything about the presented
      // credential EXCEPT the credential: whether a header came at all, whether it
      // had the `Bearer ` form, how long the presented part was, and how many runs
      // the relay currently knows. No byte of the value, and no fragment of it,
      // because a log is read by more eyes than a bearer is.
      log(`relay refused ${req.method} ${pathname}: unauthorized `
        + `(authorization header ${auth ? 'present' : 'absent'}, `
        + `bearer form ${auth.startsWith('Bearer ') ? 'yes' : 'no'}, `
        + `presented ${auth.startsWith('Bearer ') ? auth.length - 7 : 0} chars, `
        + `${runs.size} run(s) known)`);
      deny(res, 401, 'unauthorized');
      req.resume();
      return;
    }
    const { runId } = entry;
    if (!allowed(req.method, pathname, entry)) {
      deny(res, 404, 'not found');
      req.resume();
      return;
    }

    if (pathname === MCP_PATH && req.method === 'POST') {
      readBody(req, MAX_BODY_BYTES, (body) => {
        if (body === null) {
          deny(res, 413, 'request body too large');
          return;
        }
        const verdict = judgeClientBody(body.toString('utf8'), entry.basenames);
        if (verdict.forward === true) {
          // Registered before the body goes on, so an answer cannot arrive first.
          for (const call of (verdict.calls || [])) {
            if (!call.answerable) {
              // Nothing will ever answer it, so waiting for an answer would mean
              // never recording it. Written here, where it goes on to Home
              // Assistant: the action happened, the answer could not.
              record(describeCall({ ...call, runId }, ' (no answer possible)'));
              continue;
            }
            let pending = awaiting.get(runId);
            if (!pending) { pending = new Map(); awaiting.set(runId, pending); }
            pending.set(String(call.id), { ...call, runId });
          }
          forward(req, res, pathname, body, observerFor(runId), runId);
          return;
        }
        res.writeHead(verdict.status, verdict.type ? { 'content-type': verdict.type } : {});
        res.end(verdict.body);
      });
      return;
    }
    if (hasBody(req)) {
      deny(res, 400, `a ${req.method} request carries no body`);
      req.resume();
      return;
    }
    req.resume();
    forward(req, res, pathname, null, observerFor(runId), runId);
  });

  // The request to Core, with the Home Assistant token in place of the relay's.
  // Only POST /api/mcp carries a body to Core: `body` is that body, already read
  // and judged, or null for a request that sends none. Nothing is streamed.
  function recordCamera(runId, pathname, mark) {
    record(capBytes(`camera run=${runId}${mark}: ${pathname.slice(CAMERA_PREFIX.length)}`, LINE_CAP));
  }

  function forward(req, res, pathname, body, observe, runId) {
    // The agent left while its request was being read; nothing was sent for it.
    if (res.destroyed) return;
    // What this answer holds of the budget. The response owns it: every way an
    // answer ends, delivered, refused, broken or abandoned, closes the response, and
    // the listener is in place before anything can be read or anyone can leave.
    const share = answerHold();
    let answered = false;
    const headers = { authorization: `Bearer ${haToken}` };
    for (const [name, value] of Object.entries(req.headers)) {
      if (FORWARD_TO_CORE.has(name)) headers[name] = value;
    }
    if (body !== null) headers['content-length'] = String(body.length);

    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: pathname,
        headers,
        // See the header comment: the name in the certificate cannot match the
        // internal one, the hop never leaves the host, and the destination is
        // derived by us rather than supplied by anyone.
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (upRes) => {
        answered = true;
        if (pathname === MCP_PATH) observeMcpAnswer(upRes.statusCode, `${req.method} ${pathname}`);
        // Only while the run is still live: an answer that lands after its bearer
        // was revoked would leave a mark nothing ever clears.
        if (authFromStatus(upRes.statusCode) === 'unauthorized'
          && [...runs.values()].some((entry) => entry.runId === runId)) {
          refusedRuns.set(runId, upRes.statusCode);
        }
        const redirected = upRes.statusCode >= 300 && upRes.statusCode < 400;
        if (CAMERA_PATH_RE.test(pathname)) {
          // A camera read is a Home Assistant action too, and it is not a tool
          // call: no name, no arguments, so it gets a line of its own rather than
          // a place in one that would have to leave them empty. A redirect is not
          // an error answer to the read — it is no answer to it, and the mark says
          // only what it means.
          const ok = upRes.statusCode >= 200 && upRes.statusCode < 300;
          recordCamera(runId, pathname, ok ? '' : (redirected ? ' (no answer)' : ' (failed)'));
        }
        // Nobody is left to read it: what it says about the token and the camera read
        // is noted above, and the rest goes nowhere.
        if (res.destroyed) {
          upRes.resume();
          return;
        }
        // A redirect is never followed: node does not follow by default, and the
        // Authorization header must not travel to another origin. Surfaced as a
        // plain error so it cannot be mistaken for an auth failure.
        if (redirected) {
          upRes.resume();
          deny(res, 502, `core returned a redirect (${upRes.statusCode}) — not followed`);
          return;
        }
        const out = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (FORWARD_TO_CLIENT.has(name)) out[name] = value;
        }
        // An answer that breaks must end what the agent is reading: without this it
        // waits on a response that will never finish. Before the headers it can
        // still be told why; after them, only that the answer did not complete.
        const stopped = () => {
          if (res.destroyed) return;
          log(`relay upstream: Home Assistant stopped answering ${req.method} ${pathname}`);
          if (!res.headersSent) deny(res, 502, 'Home Assistant stopped answering');
          else res.destroy();
        };
        upRes.once('error', stopped);
        const type = String(upRes.headers['content-type'] || '');
        if (pathname !== MCP_PATH || !(upRes.statusCode >= 200 && upRes.statusCode < 300)) {
          // An answer Home Assistant refused used to travel back untouched and
          // unsaid: the agent reported that its tool was unavailable, this relay's
          // log held nothing, and the audit records only calls that happened. A
          // wrong Home Assistant token therefore looked exactly like an agent that
          // never dialled — the failure that explains everything was the one fact
          // nobody could see. The wording separates it from this relay's own
          // refusal (`relay refused …`, a bearer THIS relay does not know), and
          // 401/403 are named as configuration, because that is what the person
          // running the add-on can fix. The token is never logged.
          if (!(upRes.statusCode >= 200 && upRes.statusCode < 300)) {
            const what = authFromStatus(upRes.statusCode) === 'unauthorized'
              ? refusedTokenHint(upRes.statusCode)
              : `answered ${upRes.statusCode}`;
            log(`relay upstream: Home Assistant ${what} for ${req.method} ${pathname}`);
          }
          res.writeHead(upRes.statusCode, out);
          upRes.pipe(res);
        } else if (type.startsWith('text/event-stream')) {
          // Streamed, not buffered: each allowed event goes on as soon as it is
          // complete.
          delete out['content-length'];
          res.writeHead(upRes.statusCode, out);
          upRes.setEncoding('utf8');
          // Home Assistant waits for an agent that is not reading, so what piles up
          // here is only the event still being read, and that counts as held.
          const sse = createSseFilter((chunk) => { if (!res.write(chunk)) upRes.pause(); }, observe);
          res.on('drain', () => upRes.resume());
          upRes.on('data', (chunk) => {
            if (res.destroyed) return;
            const before = sse.held();
            sse.push(chunk);
            if (share.take(sse.held() - before)) return;
            log(`relay upstream: ${answerTooLarge(`${req.method} ${pathname}`)}`);
            res.destroy();
          });
          upRes.on('end', () => { sse.end(); res.end(); });
        } else if (type.startsWith('application/json')) {
          // Its share is held until the agent has the answer: a slow reader keeps the
          // bytes here. So neither side may stall for long while holding it, or one
          // connection could keep every other answer refused. No limit runs before
          // the headers: nothing is held yet, and a tool may rightly take its time.
          watchStall(upRes, LOOKUP_TIMEOUT_MS, () => {
            stopped();
            upRes.off('error', stopped);
            upRes.destroy();
          });
          readAdmitted(upRes, share.take, (raw) => {
            if (raw === null) {
              // Not an answer that may not reach the agent, which would leave it
              // waiting for one: it gets its own refusal, like a redirect.
              const why = answerTooLarge(`${req.method} ${pathname}`);
              log(`relay upstream: ${why}`);
              share.release();
              deny(res, 502, why);
              upRes.off('error', stopped);
              upRes.destroy();
              return;
            }
            const text = raw.toString('utf8');
            const kept = filterServerJson(text, observe);
            if (kept === '') {
              delete out['content-type'];
              delete out['content-length'];
              res.writeHead(202, out);
              res.end();
              return;
            }
            // The bytes as they came when all of it may pass: once the agent is
            // only being written to, the text and what it parsed to are not held.
            const answer = kept === text ? raw : Buffer.from(kept);
            const deadline = setTimeout(() => res.destroy(), deliveryDeadlineMs);
            deadline.unref();
            res.once('close', () => clearTimeout(deadline));
            out['content-length'] = String(answer.length);
            res.writeHead(upRes.statusCode, out);
            res.end(answer);
          });
        } else {
          // A success the agent cannot read as JSON-RPC carries nothing it may
          // see: its status passes, its body does not.
          upRes.resume();
          delete out['content-length'];
          delete out['content-type'];
          res.writeHead(upRes.statusCode, out);
          res.end();
        }
      },
    );

    // An agent that leaves has no use for the rest of an answer, so Home Assistant is
    // not kept sending it. Only a POST can be running a tool, and before its answer
    // starts it stays open: Home Assistant cancels a tool whose request closes,
    // wherever it has got to, and a script stopped halfway can leave a device on.
    // Same tick as the request: nothing can have closed in between.
    res.once('close', () => {
      share.release();
      if (res.writableFinished) return;
      if (answered || body === null) {
        upstream.destroy();
        return;
      }
      const limit = setTimeout(() => upstream.destroy(), abandonedRequestMs);
      limit.unref();
      upstream.once('close', () => clearTimeout(limit));
    });

    upstream.on('error', (err) => {
      if (!res.destroyed) log(`relay upstream error: ${err.message}`);
      // The read never reached Home Assistant, or its answer never came back.
      // Silence is not a record of it.
      if (CAMERA_PATH_RE.test(pathname)) recordCamera(runId, pathname, ' (no answer)');
      if (!res.headersSent) deny(res, 502, 'core unreachable');
      else res.end();
    });

    if (body !== null) upstream.end(body);
    else upstream.end();
  }

  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  }));
  server.on('error', (err) => log(`relay server error: ${err.message}`));

  // A connection reaching the relay is itself a fact worth saying, and nothing
  // else says it: every other line here is written by the request handler, which
  // runs only once a whole HTTP request has been parsed. A caller that opens a
  // socket and never completes a request therefore looked exactly like a caller
  // that never dialled at all — the silence of "nobody came" and the silence of
  // "came and did not finish" arrived by the same path. Measured 2026-09-18: an
  // agent whose MCP transport failed left this relay's log empty either way.
  //
  // One line per accepted connection: when, which local port answered, which
  // remote port dialled, and how many connections this relay has accepted since
  // it started. No byte of any credential — a connection has none yet.
  let accepted = 0;
  server.on('connection', (socket) => {
    accepted += 1;
    log(`relay accepted connection ${accepted} on 127.0.0.1:${socket.localPort} from port ${socket.remotePort}`);
  });

  // One request of the relay's OWN to Core, with the Home Assistant token: no
  // agent is behind it, so it opens no door on the loopback server. Resolves to
  // {status, json, tooLarge} (json null when the body is not JSON or is past the
  // bound); rejects when Core cannot be reached, does not answer within the
  // timeout, or stops halfway through its answer.
  function coreRequest(method, pathname, payload, readAnswer = readJsonAnswer) {
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const headers = { authorization: `Bearer ${haToken}`, accept: 'application/json' };
    if (body !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    return new Promise((resolve, reject) => {
      const upstream = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: pathname,
        headers,
        timeout: LOOKUP_TIMEOUT_MS,
        ...(secure ? { rejectUnauthorized: false } : {}),
      }, (upRes) => {
        if (pathname === MCP_PATH) observeMcpAnswer(upRes.statusCode, `${method} ${pathname}`);
        upRes.on('error', reject);
        readAnswer(upRes, (answer) => resolve({ status: upRes.statusCode, ...answer }));
      });
      upstream.on('timeout', () => upstream.destroy(new Error('core did not answer in time')));
      upstream.on('error', reject);
      upstream.end(body === null ? undefined : body);
    });
  }

  // The core's own MCP conversation with Home Assistant, for one lookup or one
  // write: the tool list is asked for once, and a basename resolves to the name
  // Home Assistant publishes it under (it renames and namespaces them).
  // `request` resolves to the raw {status, json}; `callTool` to the result of an
  // answer that is one, and rejects otherwise.
  function coreTools() {
    let rpcId = 0;
    let tools = null;
    function request(method, params) {
      rpcId += 1;
      return coreRequest('POST', MCP_PATH, { jsonrpc: '2.0', id: rpcId, method, params });
    }
    async function rpc(method, params) {
      const { status, json, tooLarge } = await request(method, params);
      if (tooLarge) throw new Error(answerTooLarge(method));
      if (status !== 200 || !json || json.error || !json.result) {
        throw new Error(`Home Assistant answered ${method} with ${status}`);
      }
      return json.result;
    }
    return {
      request,
      async publishedName(basename) {
        if (tools === null) {
          const listed = await rpc('tools/list', {});
          tools = Array.isArray(listed.tools) ? listed.tools : [];
        }
        const published = tools.filter((t) => t && haBasename(t.name) === basename);
        if (published.length === 0) throw new Error(`Home Assistant publishes no ${basename} tool`);
        return published[0].name;
      },
      callTool: (name, args) => rpc('tools/call', { name, arguments: args }),
    };
  }

  // The relay's own probe of the token. One at a time: a probe asked for while
  // one is in flight gets that one's answer. An answer that says nothing about
  // the token (no answer, a redirect, a 404 because the Model Context Protocol
  // Server is not set up, a 5xx) is 'unreachable' — the token could not be
  // checked, which is not the same as refused — unless an answer about the
  // token arrived while the probe was in flight, which is newer and stands.
  let probing = null;
  function probeAuth() {
    if (probing) return probing;
    const answersBefore = tokenAnswers;
    const unanswered = (why) => {
      if (tokenAnswers === answersBefore) noteMcpAuth('unreachable', why);
    };
    probing = coreRequest('POST', MCP_PATH, AUTH_PROBE)
      .then(({ status }) => {
        if (authFromStatus(status) === null) unanswered(`initialize answered ${status}`);
      }, (err) => {
        unanswered(`initialize: ${err.message}`);
      })
      .then(() => {
        probing = null;
        return mcpAuth;
      });
    return probing;
  }
  // The start asks at once rather than waiting for the first chat, then asks
  // again on a timer, so a token that stops being accepted (its user demoted,
  // the server's administrator option turned on) shows without a chat.
  //
  // The timer does not ask while the token is refused. Home Assistant counts
  // every 401 as a failed login: it writes a warning, raises a "Login attempt
  // failed" notification, and with `login_attempts_threshold` set it bans the
  // add-on's address — after which even a corrected token is refused. So a
  // refused token is asked about again only by a run or a lookup, which someone
  // asked for, or by the start that follows a change of the add-on's options.
  let probeTimer = null;
  if (authProbeEveryMs > 0) {
    probeAuth();
    probeTimer = setInterval(() => {
      if (mcpAuth !== 'unauthorized') probeAuth();
    }, authProbeEveryMs);
    probeTimer.unref();
  }

  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    // A bearer for one run, carrying what that run may do. `cameras` are the
    // entities the run may read. Anything absent means the run may not: this is
    // the only place a bearer is created, so there is no window in which it means
    // more.
    //
    // `basenames` go through `haBasename` here — the SAME rule the wire name is
    // reduced by — so both sides of the comparison speak basenames and no name can
    // mean one thing on the way in and another on the way out. A confirmed intent
    // may legitimately carry `__` (`INTENT_RE` in security.js allows `_`), and
    // storing it verbatim would refuse every call of that run while the adapter
    // allowed it: fail-closed, silent, and impossible to see from either side.
    issue(runId, { basenames = [], cameras = [] } = {}) {
      const token = crypto.randomBytes(32).toString('base64url');
      runs.set(token, {
        runId,
        basenames: new Set([...basenames].map(haBasename)),
        cameras: new Set(cameras),
      });
      return token;
    },
    revoke(token) {
      const entry = runs.get(token);
      runs.delete(token);
      if (entry === undefined) return;
      refusedRuns.delete(entry.runId);
      settleUnanswered(entry.runId);
    },
    // What the core asks Home Assistant to learn which entity a device the model
    // named is (targets.js): the live-context tool by name, and the states list.
    // Each tool call is recorded against the run, marked as a lookup.
    lookup(runId) {
      const ha = coreTools();
      async function callLive(args) {
        const call = { name: await ha.publishedName(LIVE_CONTEXT), args, runId };
        let result;
        try {
          result = await ha.callTool(call.name, args);
        } catch (err) {
          record(describeCall(call, ' (lookup, failed)'));
          throw err;
        }
        const text = toolText(result);
        let answer;
        try { answer = JSON.parse(text); } catch { answer = null; }
        // Home Assistant before 2026.10 answered {success: true, result}; from
        // 2026.10 it answers {result} and marks a miss with isError alone. A
        // result is read unless one of the two says it failed.
        const ok = result.isError !== true && answer !== null && typeof answer === 'object'
          && typeof answer.result === 'string' && answer.success !== false;
        record(describeCall(call, ok ? ' (lookup)' : ' (lookup, no match)'));
        return { ok, text: ok ? answer.result : '' };
      }
      return {
        live: (name) => callLive({ name }),
        liveDomain: (domain) => callLive({ domain }),
        async states() {
          const { status, json, tooLarge, why } = await coreRequest('GET', '/api/states', undefined, readStatesAnswer);
          if (status !== 200) throw new Error(`Home Assistant answered the states list with ${status}`);
          if (tooLarge) throw new Error(why());
          if (json === null) throw new Error("Home Assistant's states list is not a list");
          return json;
        },
      };
    },
    // How the core carries out one confirmed action itself (execute.js): the
    // published tool for `basename`, called with `args`, and Home Assistant's own
    // answer read once — {ok: true}, or {ok: false, error} saying why. Each call
    // is recorded against the run like any other: `(failed)` when Home Assistant
    // answered with a failure, `(no answer)` when it did not answer at all.
    act(runId) {
      const ha = coreTools();
      return async function call(basename, args) {
        let name;
        try {
          name = await ha.publishedName(basename);
        } catch (err) {
          return { ok: false, error: err.message };
        }
        const recorded = { name, args, runId };
        let answered;
        try {
          answered = await ha.request('tools/call', { name, arguments: args });
        } catch (err) {
          record(describeCall(recorded, ' (no answer)'));
          return { ok: false, error: `Home Assistant did not answer: ${err.message}` };
        }
        // Too large says nothing about the action: it went out, its answer went unread.
        const error = answered.tooLarge ? answerTooLarge('tools/call') : actionError(answered);
        const mark = answered.tooLarge ? ' (answer too large)' : (error === null ? '' : ' (failed)');
        record(describeCall(recorded, mark));
        return error === null ? { ok: true } : { ok: false, error };
      };
    },
    // Whether Home Assistant accepts the token on the MCP path (see mcpAuth).
    mcpAuth: () => mcpAuth,
    // The status (401 or 403) Home Assistant answered this run's own requests
    // with, or null if it has not refused them: what a run is told when the
    // token it rode on was the reason it could not read the house.
    tokenRefusal: (runId) => refusedRuns.get(runId) ?? null,
    probeAuth,
    close() {
      if (probeTimer) clearInterval(probeTimer);
      // Every run still open ends here, so its calls are settled before the
      // tokens go. The keys are copied because settling deletes as it goes.
      for (const runId of [...awaiting.keys()]) settleUnanswered(runId);
      runs.clear();
      refusedRuns.clear();
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { startCoreRelay, refusedTokenHint, allowed, CAMERA_PATH_RE, MCP_PATH };
