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

const http = require('node:http');
const https = require('node:https');
const { MAX_BODY_BYTES, judgeClientBody, filterServerJson, createSseFilter } = require('./mcp-filter');

// Exactly what the add-on needs, and nothing else.
const MCP_PATH = '/api/mcp';
const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);
const CAMERA_PATH_RE = /^\/api\/camera_proxy\/[a-z_]+\.[a-z0-9_]+$/;

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

function allowed(method, pathname) {
  if (pathname === MCP_PATH) return MCP_METHODS.has(method);
  if (method === 'GET' && CAMERA_PATH_RE.test(pathname)) return true;
  return false;
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
 * @param {string} opts.relayToken  Per-boot bearer the local client must present.
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{url: string, port: number, close: () => void}>}
 */
async function startCoreRelay({ coreOrigin, haToken, relayToken, log = () => {} }) {
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
    if (auth !== `Bearer ${relayToken}`) {
      deny(res, 401, 'unauthorized');
      req.resume();
      return;
    }
    if (!allowed(req.method, pathname)) {
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
        const verdict = judgeClientBody(body.toString('utf8'));
        if (verdict.forward === true) {
          forward(req, res, pathname, body);
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
    forward(req, res, pathname, null);
  });

  // The request to Core, with the Home Assistant token in place of the relay's.
  // Only POST /api/mcp carries a body to Core: `body` is that body, already read
  // and judged, or null for a request that sends none. Nothing is streamed.
  function forward(req, res, pathname, body) {
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
        // A redirect is never followed: node does not follow by default, and the
        // Authorization header must not travel to another origin. Surfaced as a
        // plain error so it cannot be mistaken for an auth failure.
        if (upRes.statusCode >= 300 && upRes.statusCode < 400) {
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
          res.writeHead(upRes.statusCode, out);
          upRes.pipe(res);
        } else if (type.startsWith('text/event-stream')) {
          // Streamed, not buffered: each allowed event goes on as soon as it is
          // complete.
          delete out['content-length'];
          res.writeHead(upRes.statusCode, out);
          upRes.setEncoding('utf8');
          const sse = createSseFilter((chunk) => res.write(chunk));
          upRes.on('data', (chunk) => sse.push(chunk));
          upRes.on('end', () => { sse.end(); res.end(); });
        } else if (type.startsWith('application/json')) {
          readBody(upRes, (raw) => {
            const kept = raw === null ? '' : filterServerJson(raw.toString('utf8'));
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

  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { startCoreRelay, allowed, CAMERA_PATH_RE, MCP_PATH };
