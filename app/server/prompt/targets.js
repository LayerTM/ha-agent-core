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
// Two oracles, both Home Assistant's own. The live-context tool, asked for a
// name, answers with the EXPOSED entities that name (or alias, or entity id)
// matches — and since 2026.12, when nothing matches exactly, with every exposed
// entity whose name, alias or id merely CONTAINS the text; its answer says which
// device, never whether an entity is exposed. That is the other oracle's: Home
// Assistant's exact list of exposed entities, keyed by entity id (exposure.js).
//
// The states list only proposes candidates: every entity whose id is the
// reference or whose name is it. A candidate is considered only when the list
// says it is exposed. It is the answer when asking the live context for its id
// returns the very device the name returned — same names, same domain, same
// areas — it is the only such candidate, and no other exposed device of that
// domain looks the same (the live context joins a device's aliases with ", ", so
// two devices can print identically). Anything else is refused:
//
//   unknown      the matcher finds no exposed device by that reference (a hit
//                that only contains the text is no device it names);
//   ambiguous    it finds several, or the device it found is not unique;
//   unpinned     it finds one, and no candidate is it (an alias, most likely);
//   unavailable  a lookup failed, the exposed list could not be read, or the
//                answer names more devices, or takes longer, than one answer may;
//   too_large    Home Assistant's answer to a lookup is past what may be read.
//
// Nothing here ever returns an id Home Assistant did not match.

const { validateProposal } = require('./security');

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

// Home Assistant's own `State.name` and `_normalize_name`.
function stateName(state) {
  const friendly = state.attributes && state.attributes.friendly_name;
  if (typeof friendly === 'string' && friendly) return friendly;
  return state.entity_id.slice(state.entity_id.indexOf('.') + 1).replace(/_/g, ' ');
}
const normalize = (name) => name.trim().toLowerCase();

// The lines of a live-context answer that say something. Home Assistant's YAML
// ends with a newline, so the last device of an answer is followed by an empty
// line and every other device is not: a blank line, or blanks at the end of one,
// says where a block sits in the answer, never which device it is.
const contentLines = (text) => text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');

// What identifies a device in the live context: its names, domain and areas.
// Its state and attributes are left out, because they may change between two
// questions about the same device.
const IDENTITY_KEYS = new Set(['names', 'domain', 'areas']);
function identity(text) {
  const kept = [];
  let key = null;
  for (const line of contentLines(text)) {
    const top = /^(?:- | {2})([A-Za-z_]+):/.exec(line);
    if (top) key = top[1];
    else if (/^\S/.test(line)) key = null;
    if (key !== null && IDENTITY_KEYS.has(key)) kept.push(line);
  }
  return kept.join('\n');
}
// The live context's device blocks, one text per device.
function deviceBlocks(text) {
  const blocks = [];
  for (const line of contentLines(text)) {
    if (line.startsWith('- ')) blocks.push([line]);
    else if (blocks.length > 0) blocks[blocks.length - 1].push(line);
  }
  return blocks.map((b) => b.join('\n'));
}
const deviceCount = (text) => deviceBlocks(text).length;
// Whether some device of a live-context answer is named `ref` — by its name or by
// an alias, as one whole entry of the names line — and not merely contains it.
// The names line joins a device's names with ", ".
const namesRef = (text, ref) => {
  const wanted = normalize(ref);
  return deviceBlocks(text).some((block) => {
    const m = /^(?:- | {2})names: (.*)$/m.exec(block);
    return m !== null && `, ${m[1].toLowerCase()}, `.includes(`, ${wanted}, `);
  });
};
const domainOf = (text) => {
  const m = /^(?:- | {2})domain: (\S+)$/m.exec(contentLines(text).join('\n'));
  return m ? m[1] : null;
};

// How many distinct devices one answer may name, and how long looking them up may take.
const MAX_REFS = 60;
const RESOLVE_DEADLINE_MS = 30000;

/**
 * @param {{ live(name: string): Promise<{ok: boolean, text: string}>,
 *           liveDomain(domain: string): Promise<{ok: boolean, text: string}>,
 *           exposed(): Promise<Set<string>>,
 *           states(): Promise<Array<{entity_id: string, attributes?: object}>> }} lookup
 * @param {{ take(bytes: number): boolean }} memory  what may be remembered
 * @param {AbortSignal} signal  aborted once nobody waits for this resolver: it asks nothing more
 */
function createResolver(lookup, memory, signal) {
  // An answer remembered is an answer not asked for again, and that is all it is: one
  // that does not fit is forgotten, and asked for again when it next comes up. While
  // it is on its way it is shared, so a name wanted twice at once goes out once.
  const remembering = (ask) => {
    const remembered = new Map();
    return (key) => {
      if (remembered.has(key)) return remembered.get(key);
      signal.throwIfAborted();
      const asking = ask(key).then((answer) => {
        if (!memory.take(Buffer.byteLength(answer.text))) remembered.delete(key);
        return answer;
      });
      remembered.set(key, asking);
      return asking;
    };
  };
  const live = remembering((name) => lookup.live(name));
  const liveDomain = remembering((domain) => lookup.liveDomain(domain));
  let statesMemo = null;
  const states = () => {
    if (statesMemo === null) {
      signal.throwIfAborted();
      statesMemo = lookup.states();
    }
    return statesMemo;
  };

  let exposedMemo = null;
  const exposedIds = () => {
    if (exposedMemo === null) {
      signal.throwIfAborted();
      exposedMemo = lookup.exposed();
    }
    return exposedMemo;
  };

  // The candidates Home Assistant exposes, each with the identity its own id gets.
  // Exposure is read from the exact list, never inferred from a live-context answer.
  async function exposedCandidates(ref) {
    const wanted = normalize(ref);
    const all = await states();
    const candidates = all.filter((s) => s && typeof s.entity_id === 'string'
      && (s.entity_id === ref || normalize(stateName(s)) === wanted));
    if (candidates.length === 0) return [];
    const exposedSet = await exposedIds();
    const out = [];
    for (const s of candidates) {
      if (!exposedSet.has(s.entity_id)) continue;
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
    // No exposed entity is named so, and no device answers to it as a whole name or
    // alias: what the matcher returned only contains the text.
    if (exposed.length === 0 && !namesRef(byName.text, ref)) return { problem: 'unknown', ref, candidates: [] };
    const candidates = exposed.map(({ id, name }) => ({ id, name }));
    if (deviceCount(byName.text) > 1) return { problem: 'ambiguous', ref, candidates };
    const found = identity(byName.text);
    const same = exposed.filter((c) => c.identity === found);
    if (same.length > 1) return { problem: 'ambiguous', ref, candidates };
    if (same.length === 0) return { problem: 'unpinned', ref, candidates };
    // The identity must single out one exposed device, or it does not prove which one it is.
    const domain = domainOf(byName.text);
    const all = domain ? await liveDomain(domain) : { ok: false, text: '' };
    const alike = all.ok ? deviceBlocks(all.text).filter((b) => identity(b) === found).length : 0;
    if (alike !== 1) return { problem: 'ambiguous', ref, candidates };
    return { id: same[0].id };
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
async function resolveAnswer(answer, lookup, { known = [], deadlineMs = RESOLVE_DEADLINE_MS } = {}) {
  const refused = { proposal: null, automation: null, problems: [{ problem: 'unavailable', ref: '', candidates: [] }] };
  const knownIds = new Set(known);
  if (distinctRefs(answer, knownIds).size > MAX_REFS) return refused;
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(refused), deadlineMs); });
  const memory = lookup.memoryHold();
  // A refused resolution stops here, or it would go on asking Home Assistant for an
  // answer nobody waits for, holding what it remembered after giving back the charge.
  const nobodyWaits = new AbortController();
  try {
    return await Promise.race([resolveAll(answer, lookup, knownIds, memory, nobodyWaits.signal), deadline]);
  } finally {
    clearTimeout(timer);
    nobodyWaits.abort();
    memory.release();
  }
}

// The references one answer asks to look up: proposal targets, and draft slots
// that are not ids the edited automation already carried.
function distinctRefs({ proposal, automation }, knownIds) {
  const refs = new Set();
  for (const intent of (proposal ? proposal.intents : [])) for (const t of intent.targets) refs.add(t);
  for (const key of ['triggers', 'conditions', 'actions']) {
    if (!automation || !automation[key]) continue;
    entityIdSlots(automation[key], (_h, value) => {
      for (const v of [].concat(value)) if (!knownIds.has(v)) refs.add(v);
    });
  }
  return refs;
}

async function resolveAll({ proposal, automation }, lookup, knownIds, memory, signal) {
  const resolver = createResolver(lookup, memory, signal);
  const problems = [];
  const cache = new Map();
  // `known` ids are the edited automation's own: they stand in ITS slots only.
  // A proposal target is always looked up, so an id the caller sent cannot
  // become an action on a device Home Assistant does not expose.
  const idOf = async (ref, { inDraft = false } = {}) => {
    if (inDraft && knownIds.has(ref)) return ref;
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
        const id = await idOf(ref, { inDraft: true });
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
