'use strict';

// How the core judges the certificate Home Assistant Core presents over TLS
// (core-trust.js), through each of the three places that open such a connection:
// the relay's forwarded requests, the relay's own requests and the registry read
// over wss. The servers here are real TLS servers on loopback, with certificates
// made for the run; none carries the name the core dials them by.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const { createCoreTrust, certificateNotice } = require('../server/prompt/core-trust');
const { startCoreRelay } = require('../server/prompt/core-relay');

let dir;
const certs = {};

function openssl(args) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function newKey(name) {
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`]);
}

const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');

function made(name, chainFile = `${name}.crt`) {
  const cert = read(chainFile);
  return {
    cert,
    key: read(`${name}.key`),
    // As Node and openssl print it: upper-case, colon-separated.
    fingerprint: new crypto.X509Certificate(cert).fingerprint256,
  };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-trust-'));
  for (const name of ['ca', 'signed', 'self', 'other']) newKey(name);
  openssl(['req', '-x509', '-new', '-key', 'ca.key', '-subj', '/CN=Test CA', '-days', '2', '-out', 'ca.crt']);
  openssl(['req', '-new', '-key', 'signed.key', '-subj', '/CN=home.example.org', '-out', 'signed.csr']);
  openssl(['x509', '-req', '-in', 'signed.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-out', 'signed.crt']);
  for (const name of ['self', 'other']) {
    openssl(['req', '-x509', '-new', '-key', `${name}.key`, '-subj', '/CN=home.example.org', '-days', '2', '-out', `${name}.crt`]);
  }
  certs.ca = read('ca.crt');
  certs.signed = made('signed');
  certs.self = made('self');
  certs.other = made('other');
});

after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A fresh directory standing for /ssl, holding the given files. */
function sslDir(files = {}) {
  const root = fs.mkdtempSync(path.join(dir, 'ssl-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

/** A stand-in for Core, over TLS or not, answering HTTP and the WebSocket API. */
async function withCore(identity, run) {
  const seen = [];
  const answer = (req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/api/states' ? '[]' : '{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  };
  const server = identity ? https.createServer({ cert: identity.cert, key: identity.key }, answer) : http.createServer(answer);
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString('utf8'));
      if (m.type === 'auth') { ws.send('{"type":"auth_ok"}'); return; }
      seen.push(m.type);
      ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: { 'light.den': { aliases: ['Den'] } } }));
    });
    ws.send('{"type":"auth_required"}');
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  try {
    return await run(`${identity ? 'https' : 'http'}://127.0.0.1:${server.address().port}`, seen);
  } finally {
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  }
}

// One request through each place that opens a connection to Core.
const SITES = {
  async 'a forwarded MCP request'(relay) {
    const bearer = relay.issue('run-1', { basenames: [], cameras: [] });
    const res = await fetch(`${relay.url}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    await res.text();
    assert.equal(res.status, 200);
  },
  async "the relay's own request"(relay) {
    assert.deepEqual(await relay.lookup('run-1').states(), []);
  },
  async 'the registry read over wss'(relay) {
    assert.deepEqual([...await relay.lookup('run-1').aliases(['light.den'])], [['light.den', ['Den']]]);
  },
};

/** Uses one site against a Core presenting `identity`; returns what was reported. */
async function useSite(site, identity, trustOptions) {
  const reported = [];
  const logged = [];
  await withCore(identity, async (origin, seen) => {
    const log = (line) => { logged.push(line); };
    const trust = createCoreTrust({ sslDir: sslDir(), log, notify: async (found) => { reported.push(found); }, ...trustOptions });
    const relay = await startCoreRelay({ coreOrigin: origin, haToken: 'token', trust, log });
    try {
      await SITES[site](relay);
      assert.equal(seen.length, 1, 'the request reached Core');
    } finally {
      relay.close();
    }
  });
  return { reported, warnings: logged.filter((line) => line.includes('certificate')) };
}

for (const site of Object.keys(SITES)) {
  test(`${site}: a chain to a trusted authority passes although the name cannot match`, async () => {
    const { reported, warnings } = await useSite(site, certs.signed, { ca: certs.ca });
    assert.deepEqual(reported, []);
    assert.deepEqual(warnings, []);
  });

  test(`${site}: a self-signed certificate found under the ssl directory passes`, async () => {
    const { reported } = await useSite(site, certs.self, { sslDir: sslDir({ 'fullchain.pem': certs.self.cert }) });
    assert.deepEqual(reported, []);
  });

  test(`${site}: an unknown certificate is reported with its fingerprint, and the connection still works`, async () => {
    const { reported, warnings } = await useSite(site, certs.self, { sslDir: sslDir({ 'fullchain.pem': certs.other.cert }) });
    assert.deepEqual(reported.map((r) => r.fingerprint), [certs.self.fingerprint]);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(certs.self.fingerprint), warnings[0]);
  });

  test(`${site}: the pinned certificate passes, in either spelling`, async () => {
    for (const pin of [certs.self.fingerprint, certs.self.fingerprint.replaceAll(':', '').toLowerCase()]) {
      const { reported } = await useSite(site, certs.self, { pin });
      assert.deepEqual(reported, []);
    }
  });

  test(`${site}: another certificate than the pinned one is reported`, async () => {
    const { reported } = await useSite(site, certs.self, { pin: certs.other.fingerprint });
    assert.deepEqual(reported.map((r) => r.fingerprint), [certs.self.fingerprint]);
  });

  test(`${site}: a plain http Core is not judged`, async () => {
    const { reported, warnings } = await useSite(site, null, {});
    assert.deepEqual(reported, []);
    assert.deepEqual(warnings, []);
  });
}

test('a chain to an authority nobody trusts is reported', async () => {
  const { reported } = await useSite("the relay's own request", certs.signed, {});
  assert.deepEqual(reported.map((r) => r.fingerprint), [certs.signed.fingerprint]);
});

test('a certificate is found anywhere in a bundle and in a subdirectory of the ssl directory', async () => {
  const root = sslDir({ 'proxy/live/chain.crt': `${certs.other.cert}\n${certs.self.cert}` });
  const { reported } = await useSite("the relay's own request", certs.self, { sslDir: root });
  assert.deepEqual(reported, []);
});

test('a missing ssl directory and unreadable certificate text report the certificate, not fail the request', async () => {
  const broken = sslDir({ 'bad.pem': '-----BEGIN CERTIFICATE-----\nnot one\n-----END CERTIFICATE-----\n' });
  for (const root of [path.join(dir, 'absent'), broken]) {
    const { reported } = await useSite("the relay's own request", certs.self, { sslDir: root });
    assert.equal(reported.length, 1);
  }
});

test('a certificate put under the ssl directory later is accepted without a restart', async () => {
  const root = sslDir();
  const reported = [];
  const trust = createCoreTrust({ sslDir: root, notify: async (found) => { reported.push(found); } });
  await withCore(certs.self, async (origin) => {
    fs.writeFileSync(path.join(root, 'fullchain.pem'), certs.self.cert);
    const relay = await startCoreRelay({ coreOrigin: origin, haToken: 'token', trust });
    try { await relay.lookup('run-1').states(); } finally { relay.close(); }
  });
  assert.deepEqual(reported, []);
});

test('one certificate is warned about once across connections; a notice that failed is raised again', async () => {
  const logged = [];
  let calls = 0;
  const trust = createCoreTrust({
    sslDir: sslDir(),
    log: (line) => { logged.push(line); },
    notify: async () => { calls += 1; if (calls === 1) throw new Error('Core is starting'); },
  });
  await withCore(certs.self, async (origin) => {
    const relay = await startCoreRelay({ coreOrigin: origin, haToken: 'token', trust });
    try {
      // The registry read opens a new connection every time.
      for (let i = 0; i < 3; i += 1) await SITES['the registry read over wss'](relay);
    } finally {
      relay.close();
    }
  });
  assert.equal(calls, 2);
  assert.equal(logged.filter((line) => line.includes(certs.self.fingerprint)).length, 1);
  assert.ok(logged.some((line) => line.includes('Core is starting')), logged.join('\n'));
});

/** A certificate's fingerprint as the notice file records it. */
const hex = (identity) => identity.fingerprint.replaceAll(':', '').toLowerCase();

/** Reads the registry (a new connection each time) through `trust` from a Core presenting `identity`. */
async function connect(trust, identity, times = 1) {
  await withCore(identity, async (origin) => {
    const relay = await startCoreRelay({ coreOrigin: origin, haToken: 'token', trust });
    try {
      for (let i = 0; i < times; i += 1) await SITES['the registry read over wss'](relay);
    } finally {
      relay.close();
    }
  });
}

/** A trust whose notice calls are recorded in order. */
function tracked(options, calls) {
  return createCoreTrust({
    sslDir: sslDir(),
    notify: async () => { calls.push('raise'); },
    withdraw: async () => { calls.push('dismiss'); },
    ...options,
  });
}

test('pinning the only reported certificate and restarting dismisses the notice, once', async () => {
  const noticeFile = path.join(sslDir(), 'notice');
  const calls = [];
  await connect(tracked({ noticeFile }, calls), certs.self);
  assert.deepEqual(calls, ['raise']);
  // The add-on restarts with the pin set.
  await connect(tracked({ noticeFile, pin: certs.self.fingerprint }, calls), certs.self, 3);
  assert.deepEqual(calls, ['raise', 'dismiss']);
  // And once more: nothing is left to dismiss.
  await connect(tracked({ noticeFile, pin: certs.self.fingerprint }, calls), certs.self);
  assert.deepEqual(calls, ['raise', 'dismiss']);
});

test('an unknown certificate seen once keeps its notice through the normal connections that follow', async () => {
  const noticeFile = path.join(sslDir(), 'notice');
  const calls = [];
  // The normal Core: a chain to a trusted authority.
  const trust = tracked({ noticeFile, ca: certs.ca }, calls);
  await connect(trust, certs.self);
  await connect(trust, certs.signed, 2);
  assert.deepEqual(calls, ['raise']);
  assert.equal(fs.readFileSync(noticeFile, 'utf8'), `${hex(certs.self)}\n`);
});

test('trusting another certificate than the reported one keeps the notice, also after a restart', async () => {
  const noticeFile = path.join(sslDir(), 'notice');
  const calls = [];
  await connect(tracked({ noticeFile }, calls), certs.self);
  await connect(tracked({ noticeFile, pin: certs.other.fingerprint }, calls), certs.other, 2);
  await connect(tracked({ noticeFile, sslDir: sslDir({ 'fullchain.pem': certs.other.cert }) }, calls), certs.other);
  assert.deepEqual(calls, ['raise']);
});

test('a chain to a trusted authority never dismisses, even for a certificate reported before', async () => {
  const noticeFile = path.join(sslDir(), 'notice');
  const calls = [];
  await connect(tracked({ noticeFile }, calls), certs.signed);
  await connect(tracked({ noticeFile, ca: certs.ca }, calls), certs.signed, 2);
  assert.deepEqual(calls, ['raise']);
});

/** A trust that records which certificate each notice is raised for. */
function shown(options, calls) {
  return createCoreTrust({
    sslDir: sslDir(),
    notify: async ({ fingerprint }) => { calls.push(fingerprint); },
    withdraw: async () => { calls.push('dismiss'); },
    ...options,
  });
}

test('trusting one of two reported certificates raises the notice for the other; trusting that one dismisses it', async () => {
  const noticeFile = path.join(sslDir(), 'notice');
  const calls = [];
  // A stranger answers once, then the user's own certificate, not yet trusted.
  const first = shown({ noticeFile }, calls);
  await connect(first, certs.other);
  await connect(first, certs.self);
  assert.deepEqual(calls, [certs.other.fingerprint, certs.self.fingerprint]);
  calls.length = 0;
  // The user pins their own and restarts.
  await connect(shown({ noticeFile, pin: certs.self.fingerprint }, calls), certs.self, 2);
  assert.deepEqual(calls, [certs.other.fingerprint]);
  assert.equal(fs.readFileSync(noticeFile, 'utf8'), `${hex(certs.other)}\n`);
  calls.length = 0;
  // After another restart the stranger's is still on record, until trusted too.
  await connect(shown({ noticeFile, pin: certs.other.fingerprint }, calls), certs.other, 2);
  assert.deepEqual(calls, ['dismiss']);
  assert.equal(fs.existsSync(noticeFile), false);
});

test('the notice raised again is for the certificate reported last', async () => {
  const noticeFile = path.join(sslDir(), 'notice');
  const root = sslDir();
  const calls = [];
  await connect(shown({ noticeFile }, calls), certs.signed);
  await connect(shown({ noticeFile }, calls), certs.other);
  // After a restart the first one is reported again, so it is the newest.
  const trust = shown({ noticeFile, sslDir: root }, calls);
  await connect(trust, certs.signed);
  await connect(trust, certs.self);
  calls.length = 0;
  fs.writeFileSync(path.join(root, 'fullchain.pem'), certs.self.cert);
  await connect(trust, certs.self);
  assert.deepEqual(calls, [certs.signed.fingerprint]);
});

test('a notice that could not be raised again for the others is retried', async () => {
  const noticeFile = path.join(sslDir(), 'notice');
  const root = sslDir();
  const calls = [];
  let failing = false;
  const trust = createCoreTrust({
    sslDir: root,
    noticeFile,
    notify: async ({ fingerprint }) => {
      if (failing) { failing = false; throw new Error('Core is restarting'); }
      calls.push(fingerprint);
    },
    withdraw: async () => { calls.push('dismiss'); },
  });
  await connect(trust, certs.other);
  await connect(trust, certs.self);
  calls.length = 0;
  failing = true;
  fs.writeFileSync(path.join(root, 'fullchain.pem'), certs.self.cert);
  await connect(trust, certs.self, 3);
  assert.deepEqual(calls, [certs.other.fingerprint]);
});

test('nothing is dismissed when nothing was warned about', async () => {
  const calls = [];
  await connect(tracked({ noticeFile: path.join(sslDir(), 'notice'), pin: certs.self.fingerprint }, calls), certs.self, 2);
  assert.deepEqual(calls, []);
});

test('the reported certificate put under the ssl directory dismisses the notice, and a later unknown one raises it again', async () => {
  const root = sslDir();
  const calls = [];
  const trust = tracked({ sslDir: root }, calls);
  await connect(trust, certs.self);
  fs.writeFileSync(path.join(root, 'fullchain.pem'), certs.self.cert);
  await connect(trust, certs.self, 2);
  fs.rmSync(path.join(root, 'fullchain.pem'));
  await connect(trust, certs.self);
  assert.deepEqual(calls, ['raise', 'dismiss', 'raise']);
});

test('a dismiss that failed is tried again at the next accepted connection', async () => {
  const root = sslDir();
  const logged = [];
  let dismissals = 0;
  const trust = createCoreTrust({
    sslDir: root,
    log: (line) => { logged.push(line); },
    withdraw: async () => { dismissals += 1; if (dismissals === 1) throw new Error('Core is restarting'); },
  });
  await connect(trust, certs.self);
  fs.writeFileSync(path.join(root, 'fullchain.pem'), certs.self.cert);
  await connect(trust, certs.self, 3);
  assert.equal(dismissals, 2);
  assert.ok(logged.some((line) => line.includes('Core is restarting')), logged.join('\n'));
});

test('a dismiss waits for the notice still being raised', async () => {
  const root = sslDir();
  const calls = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const trust = createCoreTrust({
    sslDir: root,
    notify: async () => { await held; calls.push('raised'); },
    withdraw: async () => { calls.push('dismissed'); },
  });
  await connect(trust, certs.self);
  fs.writeFileSync(path.join(root, 'fullchain.pem'), certs.self.cert);
  await connect(trust, certs.self);
  assert.deepEqual(calls, []);
  release();
  await new Promise((r) => { setImmediate(r); });
  assert.deepEqual(calls, ['raised', 'dismissed']);
});

test('only the last 32 unknown certificates are remembered and recorded, the oldest forgotten first', () => {
  const logged = [];
  const noticeFile = path.join(sslDir(), 'notice');
  const trust = createCoreTrust({ sslDir: sslDir(), noticeFile, log: (line) => { logged.push(line); } });
  const show = (n) => trust.judge({
    authorized: false,
    authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    getPeerCertificate: () => ({ fingerprint256: n.toString(16).padStart(64, '0') }),
  });
  for (let n = 0; n < 33; n += 1) show(n);
  const recorded = fs.readFileSync(noticeFile, 'utf8').trim().split('\n').map((line) => Number.parseInt(line, 16));
  assert.deepEqual(recorded, Array.from({ length: 32 }, (_, i) => i + 1));
  logged.length = 0;
  show(32);
  show(1);
  assert.deepEqual(logged, []);
  show(0);
  assert.equal(logged.length, 1);
});

test('a pin that is not a SHA-256 fingerprint is said so and pins nothing', async () => {
  const logged = [];
  createCoreTrust({ pin: 'AB:CD', log: (line) => { logged.push(line); } });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /core_certificate_sha256/);
});

test('a relay that is given no trust still judges an https Core', async () => {
  const logged = [];
  await withCore(certs.self, async (origin) => {
    const relay = await startCoreRelay({ coreOrigin: origin, haToken: 'token', log: (line) => { logged.push(line); } });
    try { await relay.lookup('run-1').states(); } finally { relay.close(); }
  });
  assert.ok(logged.some((line) => line.includes(certs.self.fingerprint)), logged.join('\n'));
});

test('the notice has one id, names the fingerprint and says how to check it before pinning', () => {
  const notice = certificateNotice('AA:BB');
  assert.equal(notice.notification_id, 'agent_core_certificate');
  assert.ok(notice.message.includes('AA:BB'));
  assert.ok(notice.message.includes('core_certificate_sha256'));
  assert.ok(notice.message.includes('openssl x509'));
  assert.ok(notice.message.includes('dismiss it yourself'));
  assert.ok(notice.message.includes('every certificate'));
});
