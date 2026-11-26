'use strict';

// The aliases Home Assistant's entity registry gives an entity: the names, besides
// its own, that the live context lists it by and its matcher answers to.
//
// `config/entity_registry/get_entries` over the WebSocket API, with the token the
// user configured: the command is open to every user, administrator or not. A
// `null` alias stands for the entity's own computed name, which the states list
// already carries, so it is left out. The registry is read for NAMES only: the
// caller asks for the ids it already holds and uses an answer only for those.

const { wsCommand } = require('./ha-ws');

const COMMAND = 'config/entity_registry/get_entries';
const WHAT = 'the entity registry';

/** The Core WebSocket endpoint for a Core origin (http → ws, https → wss). */
function coreWebSocketUrl(coreOrigin) {
  const url = new URL('/api/websocket', coreOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * The registry aliases of `entityIds`, by entity id. An id the registry does not
 * know, or knows without aliases, is absent; an id that was not asked for is never
 * in the answer.
 *
 * @param {{ url: string, token?: string, entityIds: string[], timeoutMs?: number, maxBytes?: number }} opts
 * @returns {Promise<Map<string, string[]>>}
 */
function readEntityAliases({ url, token, entityIds, timeoutMs, maxBytes }) {
  const asked = new Set(entityIds);
  if (asked.size === 0) return Promise.resolve(new Map());
  return wsCommand({
    url, token, timeoutMs, maxBytes, tokenName: 'Home Assistant token', what: WHAT,
    // As for every request to Core (core-relay.js): the name in Core's certificate cannot
    // match the internal one, the hop never leaves the host, and the endpoint is derived
    // from the Supervisor's answer, never supplied by anyone.
    anyCertificate: url.startsWith('wss:'),
    command: { type: COMMAND, entity_ids: [...asked] },
    read(result) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`Home Assistant refused ${WHAT}`);
      const out = new Map();
      for (const id of asked) {
        const entry = Object.hasOwn(result, id) ? result[id] : null;
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.aliases)) continue;
        const aliases = entry.aliases.filter((a) => typeof a === 'string' && a.trim() !== '');
        if (aliases.length > 0) out.set(id, aliases);
      }
      return out;
    },
  });
}

module.exports = { readEntityAliases, coreWebSocketUrl };
