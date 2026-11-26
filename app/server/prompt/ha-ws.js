'use strict';

// One command over Home Assistant's WebSocket API, and its one answer.
//
// The protocol: Home Assistant asks for auth, the token goes out, `auth_ok`
// comes back, then the command, then its result. Anything else — no token, the
// connection fails or stalls, the token or the command is refused, the answer is
// not JSON or not what the caller reads — rejects, so a caller never mistakes
// an unread answer for an empty one.

const { WebSocket } = require('ws');

const READ_TIMEOUT_MS = 10000;
// A bound on what a misbehaving peer can make us hold; far past any real house.
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

/**
 * @param {object} opts
 * @param {string} opts.url  The WebSocket endpoint.
 * @param {string} [opts.token]  The access token the command is sent with.
 * @param {string} opts.tokenName  How errors name that token ("Supervisor token").
 * @param {string} opts.what  How errors name the answer ("the exposed-entities list").
 * @param {object} opts.command  The command, without its id.
 * @param {(result: any) => T} opts.read  Turns a successful result, whatever it is, into the value;
 *   throws when the result is not what it reads.
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes]
 * @param {boolean} [opts.anyCertificate]  Accept Core's certificate whatever name it carries
 *   (Core's own endpoint over TLS: see registry.js).
 * @returns {Promise<T>}
 * @template T
 */
function wsCommand({
  url, token, tokenName, what, command, read, anyCertificate = false,
  timeoutMs = READ_TIMEOUT_MS, maxBytes = MAX_ANSWER_BYTES,
}) {
  return new Promise((resolve, reject) => {
    if (!token) { reject(new Error(`no ${tokenName} to read ${what} with`)); return; }
    let settled = false;
    const ws = new WebSocket(url, {
      maxPayload: maxBytes, handshakeTimeout: timeoutMs, ...(anyCertificate ? { rejectUnauthorized: false } : {}),
    });
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Home Assistant did not answer ${what} in time`)), timeoutMs);
    ws.on('error', (err) => finish(new Error(`${what} could not be read: ${err.message}`)));
    ws.on('close', () => finish(new Error(`Home Assistant closed the connection before it answered ${what}`)));
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { finish(new Error('Home Assistant sent a message that is not JSON')); return; }
      if (!msg || typeof msg !== 'object') { finish(new Error('Home Assistant sent an unreadable message')); return; }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: 1, ...command }));
      } else if (msg.type === 'auth_invalid') {
        finish(new Error(`Home Assistant did not accept the ${tokenName}`));
      } else if (msg.type === 'result' && msg.id === 1) {
        if (msg.success !== true) {
          finish(new Error(`Home Assistant refused ${what}${msg.error && msg.error.code ? ` (${msg.error.code})` : ''}`));
          return;
        }
        let value;
        try { value = read(msg.result); } catch (err) { finish(err); return; }
        finish(null, value);
      }
    });
  });
}

module.exports = { wsCommand };
