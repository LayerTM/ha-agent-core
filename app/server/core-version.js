'use strict';

// Which release of the core is running, as the release archive states it.
//
// An add-on keeps only the core's `app/`, `ha-tools/` and `rootfs/` in its image,
// so the core's own package.json never reaches a running add-on. The packer
// therefore writes this file into the archive, next to this module, from the
// packed commit's package.json (tools/pack.js). A tree that was not packed — a
// checkout — has no such file and states no version, rather than a guess.

const fs = require('node:fs');
const path = require('node:path');

const CORE_VERSION_FILE = 'core-version.json';
const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * @param {string} [file]
 * @returns {{ version: string, commit: string }} `''` for what the file does not state
 */
function readCoreVersion(file = path.join(__dirname, CORE_VERSION_FILE)) {
  let stated;
  try {
    stated = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: '', commit: '' };
  }
  const pick = (key, re) => (stated && typeof stated[key] === 'string' && re.test(stated[key]) ? stated[key] : '');
  return { version: pick('version', SEMVER), commit: pick('commit', COMMIT) };
}

/** @param {{ version: string, commit: string }} core */
function describeCore(core) {
  if (!core.version) return 'core version unknown';
  return core.commit ? `core ${core.version}, commit ${core.commit.slice(0, 12)}` : `core ${core.version}`;
}

module.exports = { CORE_VERSION_FILE, readCoreVersion, describeCore };
