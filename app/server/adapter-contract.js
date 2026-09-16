'use strict';

// The one place the core loads the engine adapter.
//
// An add-on that builds on this core places its adapter at app/adapter/index.js
// in the assembled tree. Every core module that needs an engine-specific value
// asks this module for it; nothing else in the core requires the adapter, and
// the adapter may require only core leaf modules (server/prompt/security.js),
// so the graph stays acyclic.
//
// The adapter is checked when it is first loaded: a wrong apiVersion, a missing
// member or a member of the wrong type stops the add-on at startup instead of
// failing on the first request that happens to need it.

const API_VERSION = 1;

// member path -> expected typeof
const REQUIRED = {
  'runner.run': 'function',
  'runner.shutdown': 'function',
  'runner.safeLangTag': 'function',
  'runner.TIMEOUT_MS': 'number',
  'prompt.limitsCredential': 'function',
  'prompt.fetchLimits': 'function',
  'prompt.limitEntry': 'function',
  'prompt.authConfigured': 'function',
  'prompt.writeMcpConfig': 'function',
  'prompt.hasAuditHook': 'function',
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
};

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
  if (problems.length) throw new Error(`engine adapter: ${problems.join('; ')}`);
  return mod;
}

let loaded = null;

// The validated adapter. Loaded from the assembled tree on first use.
function adapter() {
  if (!loaded) {
    // Supplied by the add-on that assembles the tree, so it does not exist here.
    // @ts-ignore
    loaded = validateAdapter(require('../adapter'));
  }
  return loaded;
}

// For tests only: install an adapter before anything asked for one. There is
// no fallback — without this call the real module path is the only source.
function useAdapter(mod) {
  if (loaded) throw new Error('engine adapter: already loaded');
  loaded = validateAdapter(mod);
  return loaded;
}

module.exports = { API_VERSION, REQUIRED, OPTIONAL, validateAdapter, adapter, useAdapter };
