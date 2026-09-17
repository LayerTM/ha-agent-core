'use strict';

// A server under test binds port 0 and says which port it got; a test reads the
// port from that line. A port picked in advance can be taken by a parallel test
// between the pick and the bind.

/**
 * Runs `start` with console.log captured.
 * @template T
 * @param {() => Promise<T>} start
 * @returns {Promise<{ result: T, logged: string[] }>}
 */
async function captureLog(start) {
  const logged = [];
  const original = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  try {
    return { result: await start(), logged };
  } finally {
    console.log = original;
  }
}

/**
 * The port a `... listening on :<port>` line reports, or null when no line does.
 * @param {string} text
 * @param {string} prefix the text before ` listening on :`
 * @returns {number | null}
 */
function reportedPort(text, prefix) {
  const match = text.match(new RegExp(`${prefix} listening on :(\\d+)\\b`));
  return match ? Number(match[1]) : null;
}

module.exports = { captureLog, reportedPort };
