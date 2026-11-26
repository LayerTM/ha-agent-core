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
// and the connection is still made.

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

/** A SHA-256 fingerprint as 64 lower-case hex digits, or '' for anything else. */
function normalFingerprint(value) {
  const hex = String(value).replace(/[\s:]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
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
 */
function createCoreTrust({ pin = '', sslDir = SSL_DIR, ca, log = () => {}, notify = async () => {} } = {}) {
  const pinned = normalFingerprint(pin);
  if (pin && !pinned) log(`ERROR: ${PIN_OPTION} is not a SHA-256 fingerprint (64 hex digits, colons optional) — it is ignored`);

  const warned = new Set();
  const told = new Set();

  function judge(socket) {
    if (socket.authorized) return;
    const shown = socket.getPeerCertificate().fingerprint256 || '';
    const fingerprint = normalFingerprint(shown);
    if (fingerprint && (fingerprint === pinned || isUnder(sslDir, fingerprint))) return;
    if (!warned.has(shown)) {
      warned.add(shown);
      log(`WARNING: Home Assistant's certificate could not be verified (${socket.authorizationError});`
        + ` SHA-256 fingerprint ${shown}. Connecting anyway; a later version may refuse.`
        + ` Keep this certificate under ${sslDir} or pin it with ${PIN_OPTION}, after checking it is yours`);
    }
    if (told.has(shown)) return;
    told.add(shown);
    notify({ fingerprint: shown }).catch((err) => {
      told.delete(shown);
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

  return { options: { agent } };
}

module.exports = { createCoreTrust, certificateNotice };
