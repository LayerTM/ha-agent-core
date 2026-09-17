'use strict';

// A server's start line names the address it listens on, and the tests read it
// back from that line.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boundAddress } = require('../../server/listen');
const { reportedListen, reportedPort } = require('../fixtures/bound-port');

async function listening(t, host) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, host, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test('the start line carries the address and the port, IPv6 in brackets', async (t) => {
  const v4 = await listening(t, '127.0.0.1');
  assert.equal(boundAddress(v4), `127.0.0.1:${v4.address().port}`);
  const any = await listening(t, '0.0.0.0');
  assert.equal(boundAddress(any), `0.0.0.0:${any.address().port}`);
  const v6 = await listening(t, '::1');
  assert.equal(boundAddress(v6), `[::1]:${v6.address().port}`);
});

test('the tests read the address and the port back from that line', () => {
  assert.deepEqual(reportedListen('x\nNeutral Console listening on 127.0.0.1:8099\n', 'Neutral Console'), { host: '127.0.0.1', port: 8099 });
  assert.deepEqual(reportedListen('prompt server listening on [::]:8126 (ha_mcp: absent)', 'prompt server'), { host: '::', port: 8126 });
  assert.equal(reportedPort('Startup placeholder listening on 0.0.0.0:5', 'Startup placeholder'), 5);
  assert.equal(reportedListen('Startup placeholder listening on :5', 'Startup placeholder'), null, 'no address, no match');
  assert.equal(reportedListen('prompt server starting', 'prompt server'), null);
});
