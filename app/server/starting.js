'use strict';

// Holds the ingress port while the add-on initializes.
//
// The console can only listen once initialization has finished — persistent
// home, authentication, the engine version check, the environment — and until
// it does, nothing answers on the ingress port at all, so Home Assistant's
// panel has nothing to render. A restart therefore looked like a broken add-on
// rather than a busy one, with no way to tell how long to wait or whether to
// wait at all.
//
// So the port answers from the first moment of initialization, with a page that
// says what is happening. The run script stops this the instant before it execs
// the console, and the page's own poll of /api/health carries it across: 503
// while this is what is listening, 200 once the console is.
//
// Deliberately dependency-free (node:http and a few file reads): it must be able
// to start before anything else in the add-on is ready, including npm's opinion
// of whether node_modules is intact, and it never loads the adapter's code. The
// adapter's names and colours are data, read as such.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sources = require('./sources');
const { readBranding } = require('./branding');
const { NEUTRAL, readTheme } = require('./theme');
const { pageValues, renderPage } = require('./pages');

const PORT = Number(process.env.CLAUDE_CONSOLE_PORT || 8099);
const DEV = process.env.CLAUDE_CONSOLE_DEV === '1';
const PAGE_FILE = path.join(__dirname, '..', 'templates', 'starting.html');

// Read and rendered once, at boot. If that fails the placeholder still answers —
// a plain sentence beats an unexplained blank panel, which is the whole point.
let names = null;
try {
  names = readBranding();
} catch (err) {
  console.error(`${err.message}; the page has no product name`);
}
let colours = NEUTRAL;
try {
  colours = readTheme();
} catch (err) {
  console.error(`${err.message}; the page uses the neutral colours`);
}

let page;
try {
  if (!names) throw new Error('no names to render it with');
  page = renderPage(fs.readFileSync(PAGE_FILE, 'utf8'), 'starting.html', pageValues({ branding: names, theme: colours }));
} catch (err) {
  console.error(`starting page unavailable (${err.message}); serving plain text`);
  // A branding name and a colour need no escaping (branding.js, theme.js).
  page = `<!DOCTYPE html><meta charset="utf-8"><title>${names ? names.productName : 'Starting…'}</title>`
    + `<body style="background:${colours.ui.bg};color:${colours.ui.fg};font-family:system-ui;padding:24px">`
    + 'Starting the console…</body>';
}

const server = http.createServer((req, res) => {
  if (!sources.sourceAllowed(req.socket, DEV)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  const url = (req.url || '/').replace(/^\/+/, '/');
  if (url === '/api/health' || url.startsWith('/api/health?')) {
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, starting: true }));
    return;
  }
  // Everything else — the panel's entry document, an asset the console has not
  // started serving yet, whatever HA asks for — gets the same page. It is the
  // honest answer to all of them: there is no console here yet.
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page);
});

// A websocket cannot be honoured, and leaving the socket hanging would make the
// console's client wait on a connection that will never open.
server.on('upgrade', (req, socket) => socket.destroy());

// Never take the add-on down: if the port is already taken (a console still
// shutting down, a second copy of this) the placeholder simply steps aside.
server.on('error', (err) => {
  console.error(`startup placeholder not listening: ${err.message}`);
  process.exit(0);
});

server.listen(PORT, () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(`Startup placeholder listening on :${port}`);
});

// The run script stops this before the console binds the port. Exit at once
// rather than draining, so the handover is not held open by a poll in flight.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => process.exit(0));
}

module.exports = { server };
