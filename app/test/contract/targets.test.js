'use strict';

// A device the model NAMES becomes an entity id by Home Assistant's own matcher,
// or no proposal leaves at all. Driven through the real relay against a Core
// that answers like Home Assistant 2026.9: the live-context tool lists exposed
// devices by names, domain and areas — never by entity id — and matches a name
// by any of the device's names or aliases, or by its exact entity id.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter } = require('../fixtures/neutral-adapter');

const { adapter, branding } = createNeutralAdapter();
useAdapter(adapter, branding);

const { startCoreRelay } = require('../../server/prompt/core-relay');
const { resolveAnswer } = require('../../server/prompt/targets');
const { createPromptApp } = require('../../server/prompt/server');
const { buildRedactor } = require('../../server/prompt/security');

// The home. `exposed: false` is an entity Home Assistant does not share with Assist.
const HOME = [
  { id: 'input_boolean.sandbox_test_lamp', name: 'Sandbox Test Lamp', area: 'Office' },
  { id: 'light.desk_lamp', name: 'Desk Lamp', area: 'Office' },
  { id: 'light.desk_lamp_2', name: 'Desk Lamp', area: 'Bedroom' },
  { id: 'switch.heater', name: 'Heater', aliases: ['Warmer'] },
  { id: 'light.porch', name: 'Porch' },
  { id: 'switch.porch', name: 'Porch', exposed: false },
  { id: 'light.hidden', name: 'Hidden Light', exposed: false },
  // Its own name was removed from its aliases in Home Assistant, and another
  // device answers to it: the states list says "Reading Light", the matcher does not.
  { id: 'light.shelf', name: 'Reading Light', haNames: ['Shelf'] },
  { id: 'light.reading', name: 'Reading', aliases: ['Reading Light'] },
];
const haNames = (e) => e.haNames || [e.name, ...(e.aliases || [])];

const norm = (s) => s.trim().toLowerCase();
let tick = 0;

// Home Assistant's `yaml_util.dump` of the exposed entities: names, domain, a
// state that changes between two questions, areas.
function dump(entities) {
  tick += 1;
  return ['Live Context: An overview of the areas and the devices in this smart home:',
    ...entities.flatMap((e) => [
      `- names: ${haNames(e).join(', ')}`,
      `  domain: ${e.id.split('.')[0]}`,
      `  state: '${tick % 2 ? 'on' : 'off'}'`,
      ...(e.area ? [`  areas: ${e.area}`] : []),
    ])].join('\n');
}

function liveContext(name) {
  const hits = HOME.filter((e) => e.exposed !== false
    && (e.id === name || haNames(e).some((n) => norm(n) === norm(name))));
  if (hits.length === 0) return { success: false, error: `No device or entity named ${name}` };
  return { success: true, result: dump(hits) };
}

let core;
let coreUp = true;
let relay;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-targets-'));
const records = [];

before(async () => {
  core = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!coreUp) { res.writeHead(503); res.end(); return; }
      if (req.headers.authorization !== 'Bearer ha-token') { res.writeHead(401); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/states') {
        res.end(JSON.stringify(HOME.map((e) => ({ entity_id: e.id, state: 'on', attributes: { friendly_name: e.name } }))));
        return;
      }
      const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let result;
      if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'intent__HassTurnOff' }, { name: 'homeassistant__GetLiveContext' }] };
      } else {
        result = { content: [{ type: 'text', text: JSON.stringify(liveContext(msg.params.arguments.name)) }], isError: false };
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise((r) => { core.listen(0, '127.0.0.1', r); });
  relay = await startCoreRelay({
    coreOrigin: `http://127.0.0.1:${core.address().port}`, haToken: 'ha-token', record: (l) => records.push(l),
  });
});

after(() => {
  relay.close();
  core.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const intent = (targets, extra = {}) => ({ intent: 'HassTurnOff', targets, data: {}, risk: 'low', ...extra });
const proposalOf = (...intents) => ({ summary: 'Turn off', intents });
const resolveProposal = (proposal) => resolveAnswer({ proposal, automation: null }, relay.lookup('r1'));

test('a unique name becomes its entity id, and the rest of the intent is kept', async () => {
  const out = await resolveProposal(proposalOf(
    intent(['Sandbox Test Lamp'], { intent: 'HassLightSet', data: { brightness: 40 } }),
  ));
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.proposal, {
    summary: 'Turn off',
    intents: [{ intent: 'HassLightSet', targets: ['input_boolean.sandbox_test_lamp'], data: { brightness: 40 }, risk: 'low' }],
  });
});

test('a name in other letter case, and an exposed entity id, resolve too', async () => {
  const out = await resolveProposal(proposalOf(intent(['sandbox test lamp', 'light.porch'])));
  assert.deepEqual(out.proposal.intents[0].targets, ['input_boolean.sandbox_test_lamp', 'light.porch']);
});

test('an ambiguous name is refused, naming both candidates', async () => {
  const out = await resolveProposal(proposalOf(intent(['Desk Lamp'])));
  assert.equal(out.proposal, null);
  assert.deepEqual(out.problems, [{
    problem: 'ambiguous',
    ref: 'Desk Lamp',
    candidates: [{ id: 'light.desk_lamp', name: 'Desk Lamp' }, { id: 'light.desk_lamp_2', name: 'Desk Lamp' }],
  }]);
});

test('an unknown name is refused', async () => {
  const out = await resolveProposal(proposalOf(intent(['Garage Door'])));
  assert.equal(out.proposal, null);
  assert.deepEqual(out.problems, [{ problem: 'unknown', ref: 'Garage Door', candidates: [] }]);
});

test('an entity id the model invents is refused, whether it does not exist or is not exposed', async () => {
  for (const id of ['light.sandbox_test_lamp', 'light.hidden']) {
    const out = await resolveProposal(proposalOf(intent([id])));
    assert.equal(out.proposal, null, id);
    assert.equal(out.problems[0].problem, 'unknown', id);
  }
});

test('one unresolved target refuses the whole proposal', async () => {
  const out = await resolveProposal(proposalOf(intent(['Sandbox Test Lamp']), intent(['Garage Door'])));
  assert.equal(out.proposal, null);
  assert.deepEqual(out.problems.map((p) => p.ref), ['Garage Door']);
});

test('a twin that Home Assistant does not expose is never chosen', async () => {
  const out = await resolveProposal(proposalOf(intent(['Porch'])));
  assert.deepEqual(out.proposal.intents[0].targets, ['light.porch']);
});

test('a device matched only by an alias is refused rather than guessed', async () => {
  const out = await resolveProposal(proposalOf(intent(['Warmer'])));
  assert.equal(out.proposal, null);
  assert.equal(out.problems[0].problem, 'unpinned');
});

test('a candidate by name is not the answer unless the matcher found that very device', async () => {
  const out = await resolveProposal(proposalOf(intent(['Reading Light'])));
  assert.equal(out.proposal, null, 'light.shelf carries the name, but Home Assistant matched light.reading');
  assert.equal(out.problems[0].problem, 'unpinned');
});

test('an automation draft has every entity_id resolved, at any depth, in a string or a list', async () => {
  const automation = {
    alias: 'Night',
    triggers: [{ trigger: 'state', entity_id: 'Porch', to: 'on' }],
    conditions: [{ condition: 'state', entity_id: ['Sandbox Test Lamp'], state: 'on' }],
    actions: [{ action: 'light.turn_off', target: { entity_id: ['Sandbox Test Lamp', 'light.porch'] } }],
  };
  const out = await resolveAnswer({ proposal: null, automation }, relay.lookup('r2'));
  assert.deepEqual(out.problems, []);
  assert.equal(out.automation.triggers[0].entity_id, 'light.porch');
  assert.deepEqual(out.automation.conditions[0].entity_id, ['input_boolean.sandbox_test_lamp']);
  assert.deepEqual(out.automation.actions[0].target.entity_id, ['input_boolean.sandbox_test_lamp', 'light.porch']);
  assert.equal(automation.triggers[0].entity_id, 'Porch', 'the input is not changed');

  const bad = await resolveAnswer({
    proposal: null, automation: { ...automation, actions: [{ action: 'x', target: { entity_id: 'Desk Lamp' } }] },
  }, relay.lookup('r3'));
  assert.equal(bad.automation, null);
  assert.equal(bad.problems[0].problem, 'ambiguous');
});

test('ids of an automation being edited pass without a lookup', async () => {
  const automation = { alias: 'A', triggers: [{ trigger: 'time' }], actions: [{ target: { entity_id: 'light.hidden' } }] };
  const out = await resolveAnswer({ proposal: null, automation }, relay.lookup('r4'), { known: ['light.hidden'] });
  assert.deepEqual(out.automation.actions[0].target.entity_id, 'light.hidden');
});

test('every lookup is recorded against its run', async () => {
  records.length = 0;
  await resolveAnswer({ proposal: proposalOf(intent(['Sandbox Test Lamp'])), automation: null }, relay.lookup('run9'));
  assert.ok(records.length > 0);
  for (const line of records) assert.match(line, /^homeassistant__GetLiveContext run=run9 \(lookup(, no match)?\): \{"name":/);
});

// --- through the prompt API ---------------------------------------------------------

async function ask(lookupFor, proposal) {
  const app = createPromptApp({
    token: 'contract-token-0123456789abcdef',
    claudeBin: path.join(TMP, 'none'),
    claudeSettings: 's',
    usageBin: path.join(TMP, 'none'),
    haConfigured: true,
    model: 'm',
    workDir: TMP,
    addonVersion: 't',
    redact: buildRedactor([]),
    audit: () => {},
    lookupFor,
    runAgent: async () => ({ status: 'ok', text: 'Turning it off?', proposal, automation: null, toolsUsed: [], numTurns: 1 }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer contract-token-0123456789abcdef' },
      body: JSON.stringify({ prompt: 'turn off the lamp', mode: 'read', language: 'en' }),
    });
    return await res.json();
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('the prompt API answers a named device with its entity id', async () => {
  const body = await ask((runId) => relay.lookup(runId), proposalOf(intent(['Sandbox Test Lamp'])));
  assert.deepEqual(body.proposal.intents[0].targets, ['input_boolean.sandbox_test_lamp']);
  assert.equal(body.text, 'Turning it off?');
});

test('the prompt API says which device it could not find, and proposes nothing', async () => {
  const body = await ask((runId) => relay.lookup(runId), proposalOf(intent(['Desk Lamp'])));
  assert.equal(body.proposal, null);
  assert.match(body.text, /“Desk Lamp” matches more than one device \(Desk Lamp: light\.desk_lamp, Desk Lamp: light\.desk_lamp_2\)/);
});

test('a lookup that fails, or no Home Assistant at all, proposes nothing', async () => {
  coreUp = false;
  try {
    const body = await ask((runId) => relay.lookup(runId), proposalOf(intent(['Sandbox Test Lamp'])));
    assert.equal(body.proposal, null);
    assert.match(body.text, /couldn't look the devices up/);
  } finally { coreUp = true; }
  const none = await ask(null, proposalOf(intent(['Sandbox Test Lamp'])));
  assert.equal(none.proposal, null);
});

test('before the lookup a target is any one line of text; after it, only an entity id', () => {
  const { validateProposal } = require('../../server/prompt/security');
  const named = (t) => validateProposal(proposalOf(intent([t])), { named: true });
  assert.notEqual(named('Sandbox Test Lamp'), null);
  assert.equal(named('two\nlines'), null);
  assert.equal(named('   '), null);
  assert.equal(validateProposal(proposalOf(intent(['Sandbox Test Lamp']))), null, 'what leaves the add-on carries ids');
  assert.notEqual(validateProposal(proposalOf(intent(['light.porch']))), null);
});
