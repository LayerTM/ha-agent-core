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

// The whole body of a message, or null once it passes MAX_BODY_BYTES.
function readBody(stream, done) {
  const chunks = [];
  let size = 0;
  let over = false;
  stream.on('data', (chunk) => {
    if (over) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      over = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  stream.on('end', () => done(over ? null : Buffer.concat(chunks)));
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
 * @returns {Promise<{
 *   url: string, port: number, issue: (runId: string) => string,
 *   revoke: (token: string) => void, close: () => void,
 *   lookup: (runId: string) => {
 *     live: (name: string) => Promise<{ok: boolean, text: string}>,
 *     states: () => Promise<Array<{entity_id: string, attributes?: object}>>,
 *   },
 * }>}
 *
 * The bearer is per RUN, not per boot: `issue(runId)` mints one and `revoke`
 * takes it back, so every request the relay serves names the run that made it.
 * One relay serves them all, and the core permits two runs at once, so a bearer
 * is the only thing that can tell them apart without asking Home Assistant for
 * something Home Assistant never promised.
 */
async function startCoreRelay({ coreOrigin, haToken, log = () => {}, record = () => {} }) {
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
      readBody(req, (body) => {
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
            const what = upRes.statusCode === 401 || upRes.statusCode === 403
              ? `refused the add-on's Home Assistant token (${upRes.statusCode}) — check the token in the add-on's configuration`
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
          const sse = createSseFilter((chunk) => res.write(chunk), observe);
          upRes.on('data', (chunk) => sse.push(chunk));
          upRes.on('end', () => { sse.end(); res.end(); });
        } else if (type.startsWith('application/json')) {
          readBody(upRes, (raw) => {
            const kept = raw === null ? '' : filterServerJson(raw.toString('utf8'), observe);
            if (kept === '') {
              delete out['content-type'];
              delete out['content-length'];
              res.writeHead(202, out);
              res.end();
              return;
            }
            out['content-length'] = String(Buffer.byteLength(kept));
            res.writeHead(upRes.statusCode, out);
            res.end(kept);
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

    upstream.on('error', (err) => {
      log(`relay upstream error: ${err.message}`);
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
  // {status, json} (json null when the body is not JSON); rejects when Core
  // cannot be reached or does not answer within the timeout.
  function coreRequest(method, pathname, payload) {
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
        readBody(upRes, (raw) => {
          let json;
          try { json = raw === null ? null : JSON.parse(raw.toString('utf8')); } catch { json = null; }
          resolve({ status: upRes.statusCode, json });
        });
      });
      upstream.on('timeout', () => upstream.destroy(new Error('core did not answer in time')));
      upstream.on('error', reject);
      upstream.end(body === null ? undefined : body);
    });
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
      settleUnanswered(entry.runId);
    },
    // What the core asks Home Assistant to learn which entity a device the model
    // named is (targets.js): the live-context tool by name, and the states list.
    // Each tool call is recorded against the run, marked as a lookup.
    lookup(runId) {
      let toolName = null;
      let rpcId = 0;
      async function rpc(method, params) {
        rpcId += 1;
        const { status, json } = await coreRequest('POST', MCP_PATH, { jsonrpc: '2.0', id: rpcId, method, params });
        if (status !== 200 || !json || json.error || !json.result) {
          throw new Error(`Home Assistant answered ${method} with ${status}`);
        }
        return json.result;
      }
      return {
        async live(name) {
          if (toolName === null) {
            const listed = await rpc('tools/list', {});
            const tools = Array.isArray(listed.tools) ? listed.tools : [];
            const published = tools.filter((t) => t && haBasename(t.name) === LIVE_CONTEXT);
            if (published.length === 0) throw new Error(`Home Assistant publishes no ${LIVE_CONTEXT} tool`);
            toolName = published[0].name;
          }
          const call = { name: toolName, args: { name }, runId };
          let result;
          try {
            result = await rpc('tools/call', { name: toolName, arguments: { name } });
          } catch (err) {
            record(describeCall(call, ' (lookup, failed)'));
            throw err;
          }
          const text = Array.isArray(result.content)
            ? result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('')
            : '';
          let answer;
          try { answer = JSON.parse(text); } catch { answer = null; }
          const ok = result.isError !== true && answer !== null && answer.success === true
            && typeof answer.result === 'string';
          record(describeCall(call, ok ? ' (lookup)' : ' (lookup, no match)'));
          return { ok, text: ok ? answer.result : '' };
        },
        async states() {
          const { status, json } = await coreRequest('GET', '/api/states');
          if (status !== 200 || !Array.isArray(json)) throw new Error(`Home Assistant answered the states list with ${status}`);
          return json;
        },
      };
    },
    close() {
      // Every run still open ends here, so its calls are settled before the
      // tokens go. The keys are copied because settling deletes as it goes.
      for (const runId of [...awaiting.keys()]) settleUnanswered(runId);
      runs.clear();
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { startCoreRelay, allowed, CAMERA_PATH_RE, MCP_PATH };
