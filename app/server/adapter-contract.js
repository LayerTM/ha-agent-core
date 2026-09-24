'use strict';

// The one place the core loads the engine adapter.
//
// An add-on that builds on this core places its adapter at app/adapter/index.js
// in the assembled tree. Every core module that needs an engine-specific value
// asks this module for it; nothing else in the core requires the adapter, and
// the adapter may require only core leaf modules (server/prompt/security.js,
// server/branding.js, server/theme.js), so the graph stays acyclic.
//
// The adapter is checked when it is first loaded: a wrong apiVersion, a missing
// member or a member of the wrong type stops the add-on at startup instead of
// failing on the first request that happens to need it. Its names are loaded
// and checked with it, from app/adapter/branding.json (see branding.js), and so
// are its colours, from app/adapter/theme.json when it ships one (see theme.js).

const { readBranding, validateBranding } = require('./branding');
const { NEUTRAL, readTheme, validateTheme } = require('./theme');

const API_VERSION = 5;

// member path -> expected typeof
const REQUIRED = {
  'descriptor.engine': 'string',
  'descriptor.parseVersion': 'function',
  'runner.bin': 'string',
  'runner.launch': 'function',
  'runner.createDecoder': 'function',
  'runner.toolName': 'function',
  'runner.toolBasename': 'function',
  'prompt.limitsSource': 'function',
  'prompt.authConfigured': 'function',
  'prompt.writeMcpConfig': 'function',
  'prompt.removeSavedSessions': 'function',
  'prompt.credentials': 'function',
  'prompt.secretValues': 'function',
  'console.bin': 'string',
  'console.updateCommand': 'string',
  'console.windowName': 'string',
  'console.launcher': 'string',
};

// Absent means the feature is off; present must have this type.
const OPTIONAL = {
  'console.remoteWindow': 'function',
  'runner.endRun': 'function',
  'descriptor.versionAlias': 'string',
  'descriptor.reportsCost': 'boolean',
  // An engine whose structured output cannot describe an OPEN object — one with
  // no fixed property list, like an intent's `data` or a Home Assistant
  // automation block. The core then gives it the CLOSED form of each answer,
  // in which every open object is a string holding its JSON encoding, and
  // decodes the answer back itself. An adapter that does not declare it is
  // given exactly the schemas it always was.
  'descriptor.closedSchemasOnly': 'boolean',
  'prompt.secretPatterns': 'object',
};

// The engine name is published on /api/status and stored by clients, so it is a
// stable token. A version alias is one more status key carrying the same value
// as `engine_version`, for clients that predate it; it cannot shadow a key the
// core already publishes.
const ENGINE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const VERSION_ALIAS_RE = /^[a-z][a-z0-9]*_version$/;
const CORE_VERSION_KEYS = new Set(['engine_version']);

function member(mod, dotted) {
  return dotted.split('.').reduce((value, key) => (
    value !== null && typeof value === 'object' ? value[key] : undefined
  ), mod);
}

function validateAdapter(mod) {
  if (mod === null || typeof mod !== 'object') {
    throw new Error('engine adapter: the module does not export an object');
  }
  if (mod.apiVersion !== API_VERSION) {
    throw new Error(`engine adapter: apiVersion ${JSON.stringify(mod.apiVersion)}, this core requires ${API_VERSION}`);
  }
  const problems = [];
  for (const [dotted, type] of Object.entries(REQUIRED)) {
    const value = member(mod, dotted);
    if (typeof value !== type || (type === 'string' && value === '')) {
      problems.push(`${dotted} must be a ${type === 'string' ? 'non-empty string' : type}`);
    }
  }
  for (const [dotted, type] of Object.entries(OPTIONAL)) {
    const value = member(mod, dotted);
    if (value !== undefined && typeof value !== type) problems.push(`${dotted} must be a ${type} when present`);
  }
  const engine = member(mod, 'descriptor.engine');
  if (typeof engine === 'string' && !ENGINE_RE.test(engine)) {
    problems.push('descriptor.engine must be a lower-case token (a-z, 0-9, _ and -, at most 32)');
  }
  const alias = member(mod, 'descriptor.versionAlias');
  if (typeof alias === 'string' && (!VERSION_ALIAS_RE.test(alias) || CORE_VERSION_KEYS.has(alias))) {
    problems.push('descriptor.versionAlias must be a lower-case <name>_version key other than engine_version');
  }
  const patterns = member(mod, 'prompt.secretPatterns');
  if (patterns !== undefined
      && !(Array.isArray(patterns) && patterns.every((re) => re instanceof RegExp && re.global))) {
    problems.push('prompt.secretPatterns must be a list of global regular expressions');
  }
  if (problems.length) throw new Error(`engine adapter: ${problems.join('; ')}`);
  return mod;
}

let loaded = null;
let names = null;
let palette = null;

// The validated adapter. Loaded from the assembled tree on first use, together
// with its names.
function adapter() {
  if (!loaded) {
    // Supplied by the add-on that assembles the tree, so it does not exist here.
    // @ts-ignore
    const mod = validateAdapter(require('../adapter'));
    names = readBranding();
    palette = readTheme();
    loaded = mod;
  }
  return loaded;
}

// The adapter's validated names: { productName, consoleName, agentName, cliName, tabGlyph }.
function branding() {
  adapter();
  return /** @type {{ productName: string, consoleName: string, agentName: string, cliName: string, tabGlyph: string }} */ (names);
}

// The adapter's validated colours, or the core's neutral ones: { ui, terminal, search }.
function theme() {
  adapter();
  return /** @type {Record<string, Record<string, string>>} */ (palette);
}

// For tests only: install an adapter, its names and its colours (the neutral
// ones when not given) before anything asked for them. There is no fallback —
// without this call the assembled tree is the only source.
function useAdapter(mod, brandingValue, themeValue = NEUTRAL) {
  if (loaded) throw new Error('engine adapter: already loaded');
  const branded = validateBranding(brandingValue);
  const coloured = validateTheme(themeValue);
  loaded = validateAdapter(mod);
  names = branded;
  palette = coloured;
  return loaded;
}

module.exports = { API_VERSION, REQUIRED, OPTIONAL, validateAdapter, adapter, branding, theme, useAdapter };
