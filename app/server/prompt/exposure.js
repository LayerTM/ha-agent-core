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

const { wsCommand } = require('./ha-ws');

const ASSISTANT = 'conversation';
const COMMAND = 'homeassistant/expose_entity/list';
const SUPERVISOR_CORE_WS = 'ws://supervisor/core/websocket';
const WHAT = 'the exposed-entities list';

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
function readExposedIds({ url = SUPERVISOR_CORE_WS, token, timeoutMs, maxBytes } = {}) {
  return wsCommand({
    url, token, timeoutMs, maxBytes, tokenName: 'Supervisor token', what: WHAT, command: { type: COMMAND },
    read(result) {
      const list = result ? result.exposed_entities : null;
      if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error(`Home Assistant refused ${WHAT}`);
      const named = Object.keys(list).filter((id) => {
        const to = list[id];
        return to !== null && typeof to === 'object' && Object.hasOwn(to, ASSISTANT);
      });
      // An entity is listed under the assistants it is exposed to. Entries and not one that
      // names this assistant means the key is not the one Home Assistant uses: unreadable,
      // not "nothing exposed". An entry that says false for it is a house that exposes nothing.
      if (named.length === 0 && Object.keys(list).length > 0) {
        throw new Error(`${WHAT} has no entry for the ${ASSISTANT} assistant`);
      }
      return new Set(named.filter((id) => list[id][ASSISTANT] === true));
    },
  });
}

module.exports = { readExposedIds, SUPERVISOR_CORE_WS };
