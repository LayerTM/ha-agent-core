'use strict';

// Which entities Home Assistant exposes to its assistant, read from Home
// Assistant itself.
//
// The live-context tool lists exposed devices by their names and never by entity
// id, and from 2026.12 it also answers a name that matches nothing with every
// exposed entity whose name, alias or id merely CONTAINS the text. Asking it
// whether one entity is exposed therefore proves nothing. Home Assistant's own
// list of exposed entities is keyed by entity id and is exact:
// `homeassistant/expose_entity/list` over the WebSocket API, for the assistant
// the MCP server serves (`conversation`).
//
// That command is for administrators only, while the token the user configured
// may belong to a restricted user. So the one call is made with the add-on's
// Supervisor token, through the Supervisor's proxy to Core. The token is used
// here and nowhere else in the core: no other Home Assistant request carries it,
// and the engine's environment never holds it (run.js).

const { WebSocket } = require('ws');

const ASSISTANT = 'conversation';
const COMMAND = 'homeassistant/expose_entity/list';
const SUPERVISOR_CORE_WS = 'ws://supervisor/core/websocket';
const READ_TIMEOUT_MS = 10000;
// The list names an entity per line of a few dozen bytes; this is a house far
// larger than any real one, and a bound on what a misbehaving peer can make us hold.
const MAX_LIST_BYTES = 32 * 1024 * 1024;

/**
 * The entity ids exposed to the assistant.
 *
 * Rejects when the list cannot be read exactly: no token, the connection fails or
 * stalls, the Supervisor refuses the token, the command is refused, or the answer
 * is not the list. A caller that cannot tell exposed from not exposed must refuse.
 *
 * @param {{ url?: string, token?: string, timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<Set<string>>}
 */
function readExposedIds({
  url = SUPERVISOR_CORE_WS, token, timeoutMs = READ_TIMEOUT_MS, maxBytes = MAX_LIST_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!token) { reject(new Error('no Supervisor token to read the exposed entities with')); return; }
    let settled = false;
    const ws = new WebSocket(url, { maxPayload: maxBytes, handshakeTimeout: timeoutMs });
    const finish = (err, ids) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      if (err) reject(err); else resolve(ids);
    };
    const timer = setTimeout(() => finish(new Error('Home Assistant did not answer the exposed-entities list in time')), timeoutMs);
    ws.on('error', (err) => finish(new Error(`the exposed-entities list could not be read: ${err.message}`)));
    ws.on('close', () => finish(new Error('Home Assistant closed the connection before it listed the exposed entities')));
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { finish(new Error('Home Assistant sent a message that is not JSON')); return; }
      if (!msg || typeof msg !== 'object') { finish(new Error('Home Assistant sent an unreadable message')); return; }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: 1, type: COMMAND }));
      } else if (msg.type === 'auth_invalid') {
        finish(new Error('Home Assistant did not accept the Supervisor token'));
      } else if (msg.type === 'result' && msg.id === 1) {
        const list = msg.success === true && msg.result ? msg.result.exposed_entities : null;
        if (!list || typeof list !== 'object' || Array.isArray(list)) {
          finish(new Error(`Home Assistant refused the exposed-entities list${msg.error && msg.error.code ? ` (${msg.error.code})` : ''}`));
          return;
        }
        const ids = Object.keys(list).filter((id) => {
          const to = list[id];
          return to && typeof to === 'object' && to[ASSISTANT] === true;
        });
        // Home Assistant lists an entity only under the assistants it is exposed to. Entries
        // and not one for this assistant means the key is not the one it uses: not "nothing exposed".
        if (ids.length === 0 && Object.keys(list).length > 0) {
          finish(new Error(`the exposed-entities list has no entry for the ${ASSISTANT} assistant`));
          return;
        }
        finish(null, new Set(ids));
      }
    });
  });
}

module.exports = { readExposedIds, SUPERVISOR_CORE_WS };
