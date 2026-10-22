'use strict';

// A confirmed write, carried out by the core itself. The confirmed intents
// already name the tool, the entity and the data, so nothing is left to
// interpret and no agent runs: every intent on every target is one call of the
// Home Assistant tool of that name, with the entity id as `name` (Home
// Assistant matches an exact entity id there), in order, every one attempted
// whatever the one before it answered. What is reported for each action is Home
// Assistant's own answer to it (core-relay.js `act`).

const { oneLine, wholeCharEnd } = require('./security');

// One action's error as the answer carries it: one line, bounded, because it is
// Home Assistant's text.
const ERROR_MAX_CHARS = 300;

/**
 * @param {Array<{intent: string, targets: string[], data: object}>} intents
 *   validated by security.js `validateIntents`: every target an entity id
 * @param {(basename: string, args: object) => Promise<{ok: boolean, error?: string}>} call
 * @param {{ deadline?: number }} [opts] the time (ms since the epoch) after
 *   which no further call is started; an action not started is a failure
 * @returns {Promise<Array<{intent: string, target: string, ok: boolean, error?: string}>>}
 */
async function execute(intents, call, { deadline = Infinity } = {}) {
  const actions = [];
  for (const { intent, targets, data } of intents) {
    for (const target of targets) {
      let outcome;
      if (Date.now() >= deadline) {
        outcome = { ok: false, error: 'not attempted: the request ran out of time' };
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop -- one action at a time, in order
          outcome = await call(intent, { ...data, name: target });
        } catch (err) {
          outcome = { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      if (outcome.ok === true) {
        actions.push({ intent, target, ok: true });
      } else {
        const error = oneLine(String(outcome.error || 'failed'));
        actions.push({ intent, target, ok: false, error: error.slice(0, wholeCharEnd(error, ERROR_MAX_CHARS)) });
      }
    }
  }
  return actions;
}

module.exports = { execute };
