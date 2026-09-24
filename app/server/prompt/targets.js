'use strict';

// Which Home Assistant entity a device the model NAMED is — decided by Home
// Assistant, never guessed.
//
// Home Assistant's live context lists every exposed device by its names, domain
// and areas, and not by its entity id, so a model can only name a device. What
// the user confirms must still carry exact entity ids. This module is the one
// place that turns the one into the other, for the proposal and for the
// automation draft alike.
//
// The oracle is Home Assistant's own matcher: the live-context tool, asked for a
// name, answers with every EXPOSED entity that name (or alias, or entity id)
// matches. The states list only proposes candidates: every entity whose id is
// the reference or whose name is it. A candidate is the answer when asking the
// matcher for its id returns the very device the name returned — same names,
// same domain, same areas — and it is the only one. Anything else is refused:
//
//   unknown    the matcher finds no exposed device by that reference;
//   ambiguous  it finds several, or several candidates are that one device;
//   unpinned   it finds one, and no candidate is it (an alias, most likely).
//
// A lookup that fails is a refusal too. Nothing here ever returns an id Home
// Assistant did not match.

const { validateProposal } = require('./security');

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

// Home Assistant's own `State.name` and `_normalize_name`.
function stateName(state) {
  const friendly = state.attributes && state.attributes.friendly_name;
  if (typeof friendly === 'string' && friendly) return friendly;
  return state.entity_id.slice(state.entity_id.indexOf('.') + 1).replace(/_/g, ' ');
}
const normalize = (name) => name.trim().toLowerCase();

// What identifies a device in the live context: its names, domain and areas.
// Its state and attributes are left out, because they may change between two
// questions about the same device.
const IDENTITY_KEYS = new Set(['names', 'domain', 'areas']);
function identity(text) {
  const kept = [];
  let key = null;
  for (const line of text.split('\n')) {
    const top = /^(?:- | {2})([A-Za-z_]+):/.exec(line);
    if (top) key = top[1];
    else if (/^\S/.test(line)) key = null;
    if (key !== null && IDENTITY_KEYS.has(key)) kept.push(line);
  }
  return kept.join('\n');
}
const deviceCount = (text) => text.split('\n').filter((line) => line.startsWith('- ')).length;

/**
 * @param {{ live(name: string): Promise<{ok: boolean, text: string}>,
 *           states(): Promise<Array<{entity_id: string, attributes?: object}>> }} lookup
 */
function createResolver(lookup) {
  const liveMemo = new Map();
  const live = (name) => {
    if (!liveMemo.has(name)) liveMemo.set(name, lookup.live(name));
    return liveMemo.get(name);
  };
  let statesMemo = null;
  const states = () => {
    if (statesMemo === null) statesMemo = lookup.states();
    return statesMemo;
  };

  async function exposedCandidates(ref) {
    const wanted = normalize(ref);
    const all = await states();
    const candidates = all.filter((s) => s && typeof s.entity_id === 'string'
      && (s.entity_id === ref || normalize(stateName(s)) === wanted));
    const out = [];
    for (const s of candidates) {
      const answer = await live(s.entity_id);
      if (answer.ok) out.push({ id: s.entity_id, name: stateName(s), identity: identity(answer.text) });
    }
    return out;
  }

  // One reference → {id} or {problem, ref, candidates}.
  async function resolve(ref) {
    const byName = await live(ref);
    if (!byName.ok || deviceCount(byName.text) === 0) return { problem: 'unknown', ref, candidates: [] };
    const exposed = await exposedCandidates(ref);
    const candidates = exposed.map(({ id, name }) => ({ id, name }));
    if (deviceCount(byName.text) > 1) return { problem: 'ambiguous', ref, candidates };
    const same = exposed.filter((c) => c.identity === identity(byName.text));
    if (same.length === 1) return { id: same[0].id };
    if (same.length > 1) return { problem: 'ambiguous', ref, candidates };
    return { problem: 'unpinned', ref, candidates };
  }

  return { resolve };
}

// Every `entity_id` value in an automation block, at any depth, as one list.
function entityIdSlots(node, visit) {
  if (Array.isArray(node)) { node.forEach((v) => entityIdSlots(v, visit)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'entity_id') visit(node, value);
    else entityIdSlots(value, visit);
  }
}

/**
 * Resolve every device the answer names. A proposal leaves as validated with
 * entity ids, or not at all; so does an automation draft. `known` are entity
 * ids the request itself carried (an automation being edited): they are Home
 * Assistant's own and pass as they are.
 *
 * @returns {Promise<{proposal: object|null, automation: object|null, problems: object[]}>}
 */
async function resolveAnswer({ proposal, automation }, lookup, { known = [] } = {}) {
  const resolver = createResolver(lookup);
  const knownIds = new Set(known);
  const problems = [];
  const cache = new Map();
  const idOf = async (ref) => {
    if (knownIds.has(ref)) return ref;
    if (!cache.has(ref)) cache.set(ref, resolver.resolve(ref));
    const result = await cache.get(ref);
    if (result.id) return result.id;
    if (!problems.some((p) => p.ref === ref)) problems.push(result);
    return null;
  };

  let outProposal = null;
  if (proposal) {
    const before = problems.length;
    const intents = [];
    for (const intent of proposal.intents) {
      const targets = [];
      for (const ref of intent.targets) {
        const id = await idOf(ref);
        if (id && !targets.includes(id)) targets.push(id);
      }
      intents.push({ ...intent, targets });
    }
    if (problems.length === before) outProposal = validateProposal({ ...proposal, intents });
  }

  let outAutomation = null;
  if (automation) {
    const before = problems.length;
    const draft = structuredClone(automation);
    const slots = [];
    for (const key of ['triggers', 'conditions', 'actions']) {
      if (draft[key]) entityIdSlots(draft[key], (holder, value) => slots.push({ holder, value }));
    }
    let malformed = false;
    for (const { holder, value } of slots) {
      const refs = [].concat(value);
      if (!refs.every((r) => typeof r === 'string' && r.trim() !== '')) { malformed = true; continue; }
      const ids = [];
      for (const ref of refs) {
        const id = await idOf(ref);
        if (id && !ids.includes(id)) ids.push(id);
      }
      holder.entity_id = Array.isArray(value) ? ids : (ids[0] ?? value);
    }
    if (!malformed && problems.length === before
        && slots.every(({ holder }) => [].concat(holder.entity_id).every((id) => ENTITY_ID_RE.test(id)))) {
      outAutomation = draft;
    }
  }

  return { proposal: outProposal, automation: outAutomation, problems };
}

// Every entity id a Home Assistant config already carries (an automation being
// edited): Home Assistant's own, so they are not looked up again.
function entityIdsIn(config) {
  const ids = [];
  entityIdSlots(config, (_holder, value) => {
    for (const v of [].concat(value)) if (typeof v === 'string' && ENTITY_ID_RE.test(v)) ids.push(v);
  });
  return ids;
}

module.exports = { resolveAnswer, createResolver, entityIdsIn, identity, stateName };
