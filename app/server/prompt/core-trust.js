'use strict';

// Whether the certificate Home Assistant Core presents is the one this home
// means to present. Every TLS connection to Core takes its options from here.
//
// The name in Core's certificate is the one users type from outside, while the
// core dials `homeassistant` over the add-on network (core-target.js), so the
// names cannot match and the name is not checked. The certificate is accepted
// when any of these holds:
//   - its chain leads to an authority Node trusts;
//   - it is, byte for byte, a certificate found under the ssl directory
//     (a self-signed one, or one from a private authority);
//   - its SHA-256 fingerprint is the one the user pinned.
//
// An unaccepted certificate is logged and reported once, with its fingerprint,
// and the connection is still made. A reported certificate is answered only when
// the user trusts that very one, by the pin or the ssl directory. While others
// are unanswered the report is raised again for the newest of them; after the
// last one it is withdrawn. No other connection touches it: an unaccepted
// certificate that was there for a moment is not to vanish from sight with the
// next normal one, or with another the user trusts.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const SSL_DIR = '/ssl';
const PIN_OPTION = 'core_certificate_sha256';
const NOTICE_ID = 'agent_core_certificate';
const CERT_FILE_RE = /\.(pem|crt|cer)$/i;
const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g;
// Bounds on the search of the ssl directory, far past any real one.
const MAX_DEPTH = 3;
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 256 * 1024;
// How many unaccepted certificates are remembered as already reported.
const MAX_REMEMBERED = 32;

/** The fingerprints a notice file records, none if it cannot be read. */
function recordedFingerprints(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(normalFingerprint).filter(Boolean).slice(-MAX_REMEMBERED);
  } catch {
    return [];
  }
}

/** Adds to a set that keeps only its newest `MAX_REMEMBERED` entries. */
function remember(set, value) {
  set.add(value);
  if (set.size > MAX_REMEMBERED) set.delete(set.values().next().value);
}

/** A SHA-256 fingerprint as 64 lower-case hex digits, or '' for anything else. */
function normalFingerprint(value) {
  const hex = String(value).replace(/[\s:]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
}

/** A normalised fingerprint as Node and openssl print it. */
function printedFingerprint(hex) {
  return hex.toUpperCase().match(/../g).join(':');
}

/** The fingerprints of one file's certificates. Private keys are never read. */
function fileFingerprints(file) {
  const found = [];
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return found;
    for (const block of fs.readFileSync(file, 'utf8').match(CERT_BLOCK_RE) || []) {
      try { found.push(normalFingerprint(new crypto.X509Certificate(block).fingerprint256)); } catch { /* not a certificate */ }
    }
  } catch { /* unreadable: it vouches for nothing */ }
  return found;
}

/** Whether a certificate with this fingerprint is under `root`. */
function isUnder(root, fingerprint) {
  let left = MAX_ENTRIES;
  const search = (dir, depth) => {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch { return false; }
    for (const name of names) {
      if (left === 0) return false;
      left -= 1;
      const file = path.join(dir, name);
      let isDirectory;
      try { isDirectory = fs.statSync(file).isDirectory(); } catch { continue; }
      if (isDirectory) {
        if (depth < MAX_DEPTH && search(file, depth + 1)) return true;
      } else if (CERT_FILE_RE.test(name) && !/privkey/i.test(name) && fileFingerprints(file).includes(fingerprint)) {
        return true;
      }
    }
    return false;
  };
  return search(root, 0);
}

/** The Home Assistant notification for a certificate that was not accepted. */
function certificateNotice(fingerprint) {
  return {
    notification_id: NOTICE_ID,
    title: "Home Assistant's certificate could not be verified",
    message: [
      'The add-on connected to Home Assistant over TLS and could not verify the certificate it was shown.'
      + ' It still connects in this version; a later version may refuse.',
      `SHA-256 fingerprint of the certificate shown: ${fingerprint}`,
      'First check that this is your certificate: run `openssl x509 -noout -fingerprint -sha256 -in fullchain.pem`'
      + ' on the certificate file Home Assistant uses. If the fingerprints match, either keep that file under `/ssl`'
      + ` or set the add-on option \`${PIN_OPTION}\` to the fingerprint, and restart the add-on.`
      + ' If they do not match, do not pin it: something else is answering as Home Assistant.',
      'This notification is removed once you have trusted every certificate it reported in one of those two ways; when'
      + ' you trust one and others remain, it shows another of them. You can also dismiss it yourself.',
    ].join('\n\n'),
  };
}

/**
 * The trust applied to Core's certificate. `options` goes into every request
 * made to Core over TLS (`https.request`, `new WebSocket`).
 *
 * @param {object} [opts]
 * @param {string} [opts.pin]  The pinned SHA-256 fingerprint, as the options give it.
 * @param {string} [opts.sslDir]
 * @param {string} [opts.ca]  Authorities to trust instead of Node's own.
 * @param {(line: string) => void} [opts.log]
 * @param {(found: {fingerprint: string}) => Promise<void>} [opts.notify]  Tells
 *   the user; one that rejects is tried again at the next connection.
 * @param {() => Promise<void>} [opts.withdraw]  Takes that notice back. If it, or
 *   raising the notice again for another certificate, rejects, it is tried again
 *   when the trusted certificate next connects.
 * @param {string} [opts.noticeFile]  Holds the reported fingerprints not yet
 *   trusted, one per line, the newest last, so that this holds across restarts.
 */
function createCoreTrust({
  pin = '', sslDir = SSL_DIR, ca, log = () => {}, notify = async () => {}, withdraw = async () => {}, noticeFile = '',
} = {}) {
  const pinned = normalFingerprint(pin);
  if (pin && !pinned) log(`ERROR: ${PIN_OPTION} is not a SHA-256 fingerprint (64 hex digits, colons optional) — it is ignored`);

  const warned = new Set();
  const told = new Set();

  // The reported certificates the user has not trusted, the newest last.
  const reported = new Set(noticeFile ? recordedFingerprints(noticeFile) : []);
  // The notice calls run one after another: a withdrawal never overtakes the
  // notice it takes back.
  let calls = Promise.resolve();

  function save() {
    if (!noticeFile) return;
    try {
      if (reported.size) fs.writeFileSync(noticeFile, [...reported].map((line) => `${line}\n`).join(''), { mode: 0o600 });
      else fs.rmSync(noticeFile, { force: true });
    } catch (err) {
      log(`the state of the certificate notice could not be saved: ${err.message}`);
    }
  }

  function raise(shown) {
    remember(told, shown);
    return notify({ fingerprint: shown }).catch((err) => {
      told.delete(shown);
      throw err;
    });
  }

  /** The user trusts this certificate: whatever it was reported for is answered. */
  function trusted(fingerprint) {
    if (!reported.delete(fingerprint)) return;
    save();
    told.delete(printedFingerprint(fingerprint));
    const newest = [...reported].at(-1);
    if (!newest) told.clear();
    calls = calls.then(() => (newest ? raise(printedFingerprint(newest)) : withdraw())).catch((err) => {
      // Back as the oldest, so that its next connection does this again.
      const since = [...reported];
      reported.clear();
      for (const each of [fingerprint, ...since]) remember(reported, each);
      save();
      log(`the certificate notice could not be ${newest ? 'raised again' : 'dismissed'}: ${err.message}`);
    });
  }

  function judge(socket) {
    if (socket.authorized) return;
    const shown = socket.getPeerCertificate().fingerprint256 || '';
    const fingerprint = normalFingerprint(shown);
    if (fingerprint && (fingerprint === pinned || isUnder(sslDir, fingerprint))) { trusted(fingerprint); return; }
    if (!warned.has(shown)) {
      remember(warned, shown);
      log(`WARNING: Home Assistant's certificate could not be verified (${socket.authorizationError});`
        + ` SHA-256 fingerprint ${shown}. Connecting anyway; a later version may refuse.`
        + ` Keep this certificate under ${sslDir} or pin it with ${PIN_OPTION}, after checking it is yours`);
    }
    if (told.has(shown)) return;
    if (fingerprint) {
      // Moved to the end: the notice now shows this one.
      reported.delete(fingerprint);
      remember(reported, fingerprint);
      save();
    }
    // Marked now: the next connection may come before the call is made.
    remember(told, shown);
    calls = calls.then(() => raise(shown)).catch((err) => {
      log(`the certificate notice could not be raised: ${err.message}`);
    });
  }

  class CoreAgent extends https.Agent {
    createConnection(options, callback) {
      // Node's own verdict on the chain is read after the handshake, by `judge`:
      // it must not end the connection, and the name is not part of it.
      const socket = /** @type {import('node:tls').TLSSocket} */ (super.createConnection({
        ...options, ...(ca ? { ca } : {}), rejectUnauthorized: false, checkServerIdentity: () => undefined,
      }, callback));
      socket.once('secureConnect', () => judge(socket));
      return socket;
    }
  }
  // As the default agent connects, except that no TLS session is resumed: every
  // new connection shows its certificate and is judged.
  const agent = new CoreAgent({ keepAlive: true, scheduling: 'lifo', timeout: 5000, maxCachedSessions: 0 });

  return { options: { agent }, judge };
}

module.exports = { createCoreTrust, certificateNotice, NOTICE_ID };
