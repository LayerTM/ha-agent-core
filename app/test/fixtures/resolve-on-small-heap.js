'use strict';

// One answer naming the most devices an answer may, resolved by the real relay and
// resolver in a process with a small host's heap. Argument: Home Assistant's origin.

const { startCoreRelay } = require('../../server/prompt/core-relay');
const { resolveAnswer } = require('../../server/prompt/targets');

(async () => {
  const relay = await startCoreRelay({ coreOrigin: process.argv[2], haToken: 'ha-token-never-in-a-message' });
  const actions = Array.from({ length: 60 }, (_, i) => ({ action: 'light.turn_off', target: { entity_id: `Device ${i}` } }));
  const automation = { alias: 'A', triggers: [{ trigger: 'time' }], actions };
  const out = await resolveAnswer({ proposal: null, automation }, relay.lookup('run'), { deadlineMs: 120000 });
  relay.close();
  process.stdout.write(JSON.stringify({ targets: out.automation ? out.automation.actions.map((a) => a.target.entity_id) : null, problems: out.problems.length }));
})();
