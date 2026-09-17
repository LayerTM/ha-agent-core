'use strict';

// The engine's names, as the add-on declares them in app/adapter/branding.json.
//
// Data, not code, and read without loading the adapter: the startup placeholder
// runs before the adapter may be loaded, and the start script reads the same
// file with jq. The key set is closed, and a value cannot hold anything that
// would need escaping in a page, a log line or a shell string.

const fs = require('node:fs');
const path = require('node:path');

const BRANDING_FILE = path.join(__dirname, '..', 'adapter', 'branding.json');
const MAX_BYTES = 4096;

const KEYS = Object.freeze({
  productName: 'the add-on and its page title, e.g. "Claude Code"',
  consoleName: 'the web console, e.g. "Claude Console"',
  agentName: 'the agent the console runs, e.g. "Claude"',
});

// 1-64 characters, no control characters and none of < > & " ' \ `
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const NAME_RE = /^[^\u0000-\u001f\u007f<>&"'\\`]{1,64}$/;

function validateBranding(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('branding: not an object');
  }
  const problems = [];
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(KEYS, key)) problems.push(`${key} is not a branding key`);
  }
  for (const key of Object.keys(KEYS)) {
    const name = value[key];
    if (typeof name !== 'string' || !NAME_RE.test(name) || name.trim() !== name) {
      problems.push(`${key} must be 1-64 characters without control characters, quotes, < > & \\ or \` and without surrounding spaces`);
    }
  }
  if (problems.length) throw new Error(`branding: ${problems.join('; ')}`);
  return Object.freeze({ ...value });
}

function readBranding(file = BRANDING_FILE) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
      text = buffer.subarray(0, size).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new Error(`branding: ${file} cannot be read: ${err.message}`, { cause: err });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`branding: ${file} is not JSON: ${err.message}`, { cause: err });
  }
  return validateBranding(value);
}

module.exports = { BRANDING_FILE, KEYS, validateBranding, readBranding };
