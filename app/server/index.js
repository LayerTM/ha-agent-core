'use strict';

const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');
const express = require('express');
const { WebSocketServer } = require('ws');
const tmux = require('./tmux');
const { createRouter } = require('./api');
const terminal = require('./terminal');
const promptServer = require('./prompt');
const { pageValues } = require('./pages');
const { loadConsoleAssets, mountConsoleAssets } = require('./console-assets');
const sources = require('./sources');
const { boundAddress } = require('./listen');
const { adapter, branding, theme } = require('./adapter-contract');
const { readCoreVersion, describeCore } = require('./core-version');

const PORT = Number(process.env.CLAUDE_CONSOLE_PORT || 8099);
// Every interface unless one address is named, as for the startup placeholder.
const HOST = process.env.CLAUDE_CONSOLE_HOST || undefined;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const RETENTION_DAYS = Number(process.env.UPLOAD_RETENTION_DAYS || 14);
const DEV = process.env.CLAUDE_CONSOLE_DEV === '1';

function sourceAllowed(socket) {
  return sources.sourceAllowed(socket, DEV);
}

const app = express();
app.disable('x-powered-by');

// HA ingress serves the panel such that relative asset URLs resolve with a
// leading double slash (…/<token>//vendor/xterm.js). Collapse leading slashes so
// exact routes match — otherwise vendor scripts 404, and with X-Content-Type-
// Options: nosniff the HTML 404 body is refused as a script → blank console.
app.use((req, res, next) => {
  if (req.url.startsWith('//')) req.url = req.url.replace(/^\/+/, '/');
  next();
});

app.use((req, res, next) => {
  if (!sourceAllowed(req.socket)) return res.status(403).send('Forbidden');
  next();
});

// Frontend
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Cache-bust the shell's own JS/CSS by add-on version. The entry document is
// served no-store (below), but app.js / styles.css / vendor/* keep a long
// cache — and WITHOUT a version key a fresh (no-store) shell would pair with a
// STALE cached script after an update, so new markup meets old code: dead
// buttons / broken UI until the asset cache TTL (~1h) expires. Stamping
// ?v=<version> (see shell.js) makes every release a distinct cache key, so a
// fresh shell always fetches matching assets while an unchanged version still
// hits cache.
const ASSET_VERSION = process.env.ADDON_VERSION || String(Date.now());

// The pages carry the engine's names and colours, filled in here once; the
// icons are the add-on's. Either failing stops the start (console-assets.js).
const consoleAssets = loadConsoleAssets({
  templateDir: path.join(__dirname, '..', 'templates'),
  publicDir: PUBLIC_DIR,
  iconDir: path.join(__dirname, '..', 'adapter', 'icons'),
  values: pageValues({ branding: branding(), theme: theme(), console: adapter().console }),
});
mountConsoleAssets(app, consoleAssets, { assetVersion: ASSET_VERSION });

app.use('/api', createRouter({ uploadDir: UPLOAD_DIR, viewerCount: terminal.viewerCount }));

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url.replace(/^\/+/, '/'), 'http://localhost');
  if (url.pathname !== '/ws' || !sourceAllowed(socket)) {
    socket.destroy();
    return;
  }
  // Interactive echo must never wait on Nagle/delayed-ACK — that is the classic
  // "mushy remote shell" latency (up to ~40ms per keystroke). Ship immediately.
  // The upgrade socket is a net.Socket at runtime (plain-HTTP server); the http
  // 'upgrade' event types it as the base Duplex, which lacks setNoDelay.
  /** @type {import('node:net').Socket} */ (socket).setNoDelay(true);
  wss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws));
});

let promptShutdown = null;

async function cleanupUploads() {
  if (!(RETENTION_DAYS > 0)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  let entries;
  try {
    entries = await fsp.readdir(UPLOAD_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    const file = path.join(UPLOAD_DIR, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(file);
    } catch {
      /* removed concurrently */
    }
  }
}

async function main() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await tmux.ensureMain();

  // An engine's remote-control tab, when the adapter has one and the add-on
  // options turn it on: the adapter describes the window, the console opens it.
  const remote = adapter().console.remoteWindow ? adapter().console.remoteWindow(process.env) : null;
  if (remote) {
    tmux.ensureWindow(remote.name, remote.argv).catch((err) => {
      console.error('remote-control window failed:', err.stderr || err.message);
    });
  }

  cleanupUploads();
  setInterval(cleanupUploads, 6 * 3600 * 1000).unref();

  server.listen(PORT, HOST, () => {
    console.log(`${branding().consoleName} listening on ${boundAddress(server)} (${describeCore(readCoreVersion())})`);
  });

  // Companion prompt API for the claude_ha integration (separate listener,
  // own bearer-token auth model — see server/prompt/). A failure here must
  // never take the console down.
  try {
    promptShutdown = await promptServer.start();
  } catch (err) {
    console.error('prompt server failed to start (console unaffected):', err.message);
  }
}

process.on('SIGTERM', () => {
  // Open websockets keep server.close() from ever completing — drop them
  // first, and hard-exit as a backstop so add-on stop never hangs.
  terminal.shutdown();
  if (promptShutdown) promptShutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
