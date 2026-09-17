'use strict';

// A server under test binds port 0 and says which port it got; a test reads the
// port from that line. A port picked in advance can be taken by a parallel test
// between the pick and the bind.
//
// It also listens on TEST_HOST, the one address the test then talks to. A
// server listening on every interface can share its port number with another
// process's server on 127.0.0.1 (macOS allows it), and a request to
// 127.0.0.1 then reaches that other server.

const http = require('node:http');

const TEST_HOST = '127.0.0.1';

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
 * The address and port a `... listening on <address>:<port>` line reports
 * (server/listen.js), or null when no line does.
 * @param {string} text
 * @param {string} prefix the text before ` listening on `
 * @returns {{ host: string, port: number } | null}
 */
function reportedListen(text, prefix) {
  const match = text.match(new RegExp(`${prefix} listening on (\\[[^\\]]*\\]|[^\\s:]+):(\\d+)\\b`));
  return match ? { host: match[1].replace(/^\[(.*)\]$/, '$1'), port: Number(match[2]) } : null;
}

/**
 * The port such a line reports, or null.
 * @param {string} text
 * @param {string} prefix
 * @returns {number | null}
 */
function reportedPort(text, prefix) {
  const listen = reportedListen(text, prefix);
  return listen ? listen.port : null;
}

/**
 * Asserts that the line says the server listens on TEST_HOST — on every
 * system, whatever it allows beside a wildcard listener — and returns the port.
 * @param {import('node:assert')} assert
 * @param {string} text
 * @param {string} prefix
 * @returns {number}
 */
function assertListensOnTestHost(assert, text, prefix) {
  const listen = reportedListen(text, prefix);
  assert.ok(listen, `no "${prefix} listening on" line in: ${text}`);
  assert.equal(listen.host, TEST_HOST, `the server listens on ${listen.host}, the test talks to ${TEST_HOST}`);
  return listen.port;
}

/**
 * Tries to listen on TEST_HOST:port with a server of its own, as another
 * process could. Resolves to null when the port is taken there (the server
 * under test holds exactly that address), or to that server's close function.
 * @param {number} port
 * @returns {Promise<null | (() => Promise<void>)>}
 */
function foreignServerOn(port) {
  return new Promise((resolve, reject) => {
    const foreign = http.createServer((req, res) => { res.statusCode = 418; res.end('foreign'); });
    foreign.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    foreign.listen(port, TEST_HOST, () => resolve(() => new Promise((done) => foreign.close(() => done()))));
  });
}

/**
 * Asserts that no other server can take the port on the address the test uses.
 * @param {import('node:assert')} assert
 * @param {number} port
 */
async function assertPortHeld(assert, port) {
  const close = await foreignServerOn(port);
  if (close) await close();
  assert.equal(close, null, `another server could listen on ${TEST_HOST}:${port} beside the server under test`);
}

module.exports = { TEST_HOST, captureLog, reportedListen, reportedPort, assertListensOnTestHost, foreignServerOn, assertPortHeld };
