'use strict';

/* global require, process */

// Loaded into every Node process of a test run by hermetic-test.js. A connection
// to anything but this machine is refused and written to the run's record, so the
// run fails even when the code under test swallows the error: production code
// that treats a failed connection as "Home Assistant is unreachable" is the rule
// here, not the exception.
//
// Names are not resolved first. `homeassistant` is an ordinary host name on a
// developer's network and in a container there, and it may well be a real home.
//
// A child a test starts with an environment of its own has no guard: the suites
// pin such environments key by key, and those pins matter more. Suites that run
// a whole image have no network at all instead.

const fs = require('node:fs');
const net = require('node:net');

const RECORD = process.env.HERMETIC_RECORD;
const REFUSED = 'ERR_HERMETIC_NETWORK';

const LOOPBACK = /^(localhost|::1|::|0\.0\.0\.0|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;

/** The destination of a Socket#connect call, in any of the shapes it accepts. */
function destination(args) {
  const list = Array.isArray(args[0]) ? args[0] : args;
  const [first, second] = list;
  if (first && typeof first === 'object') return { host: first.host, port: first.port, path: first.path };
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { host: typeof second === 'string' ? second : undefined, port: first };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function hermeticConnect(...args) {
  const { host, port, path: socketPath } = destination(args);
  if (socketPath || !host || LOOPBACK.test(host)) return connect.apply(this, args);
  const stack = (new Error().stack || '').split('\n').slice(2, 12).join('\n');
  fs.appendFileSync(RECORD, `node connected to ${host}:${port} from ${process.argv.slice(1, 2).join(' ')}\n${stack}\n`);
  const error = Object.assign(new Error(`hermetic test run: connection to ${host}:${port} refused`), { code: REFUSED });
  process.nextTick(() => this.destroy(error));
  return this;
};
