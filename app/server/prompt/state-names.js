'use strict';

// Reads Home Assistant's states list as it arrives and keeps of each state only
// what a device lookup reads: its entity id and its friendly name. An install's
// list holds every state with all its attributes, most of them for devices no
// lookup will ever ask about, so the list is never held or parsed as a whole.
// One state is parsed at a time, and the event loop gets a turn between chunks.
//
// The scan works on bytes: every character it looks for is ASCII, and no byte of
// a multi-byte UTF-8 character can be mistaken for one, so a chunk may end
// anywhere. A state is decoded only once all of its bytes are in.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const isSpace = (byte) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;

function keptOf(state) {
  const friendly = state.attributes && state.attributes.friendly_name;
  return {
    entity_id: state.entity_id,
    attributes: typeof friendly === 'string' ? { friendly_name: friendly } : {},
  };
}

/**
 * @returns {{ push(chunk: Buffer): void,
 *             end(): Array<{entity_id: unknown, attributes: {friendly_name?: string}}>|null }}
 *   `end` gives the states, or null when what arrived is not a list of objects.
 */
function createStateNames() {
  const states = [];
  let depth = 0;           // 0 outside the list, 1 between states, 2+ inside one
  let inString = false;
  let escaped = false;
  let closed = false;
  let broken = false;
  let parts = [];          // the bytes of the state being read, from earlier chunks

  function finish(tail) {
    parts.push(tail);
    try {
      states.push(keptOf(JSON.parse(Buffer.concat(parts).toString('utf8'))));
    } catch {
      broken = true;
    }
    parts = [];
  }

  return {
    push(chunk) {
      let start = depth >= 2 ? 0 : -1;
      for (let i = 0; i < chunk.length && !broken; i += 1) {
        const byte = chunk[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) inString = false;
        } else if (depth >= 2) {
          if (byte === QUOTE) inString = true;
          else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
          else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
            depth -= 1;
            if (depth === 1) {
              finish(chunk.subarray(start, i + 1));
              start = -1;
            }
          }
        } else if (isSpace(byte)) {
          // Between tokens: nothing to read.
        } else if (closed) {
          broken = true;
        } else if (depth === 0) {
          if (byte === OPEN_BRACKET) depth = 1;
          else broken = true;
        } else if (byte === OPEN_BRACE) {
          depth = 2;
          start = i;
        } else if (byte === CLOSE_BRACKET) {
          depth = 0;
          closed = true;
        } else if (byte !== COMMA) {
          broken = true;
        }
      }
      if (start !== -1 && !broken) parts.push(chunk.subarray(start));
    },
    end() {
      return closed && !broken ? states : null;
    },
  };
}

module.exports = { createStateNames };
