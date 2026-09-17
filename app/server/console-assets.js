'use strict';

// The console's pages, rendered once at start (pages.js), and the add-on's
// icons. Both are read before the console listens, so a page that does not
// render or a missing icon stops the start instead of reaching a browser.
//
// The pages are read from their own directory, app/templates/, which nothing
// serves: the only way to a page is its rendered form. app/public/ holds the
// files served as they are, and may not hold a page, since a static server
// reaches a file under many spellings of its path.

const fs = require('node:fs');
const express = require('express');
const path = require('node:path');
const { PAGES, renderPage } = require('./pages');
const { stampAssetVersion } = require('./shell');

// Files the pages use, served straight from installed packages: the terminal
// emulator and the terminal font (JetBrains Mono, OFL-1.1).
const PACKAGE_FILES = Object.freeze({
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-unicode11.js': '@xterm/addon-unicode11/lib/addon-unicode11.js',
  '/vendor/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/addon-search.js': '@xterm/addon-search/lib/addon-search.js',
  '/vendor/addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  '/fonts/jetbrains-mono-400.woff2': '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  '/fonts/jetbrains-mono-700.woff2': '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2',
});
const PACKAGE_MAX_AGE_S = 24 * 3600;

// The add-on ships these in app/adapter/icons/; the pages link them as icons/<name>.
const ICONS = Object.freeze(['apple-touch-icon.png', 'favicon-32.png', 'favicon.svg', 'pwa-192.png', 'pwa-512.png']);

const TYPES = { html: 'html', js: 'js', css: 'css', json: 'webmanifest' };
// As app/public/ is served: the entry documents never cached, everything else
// for an hour.
const ASSET_MAX_AGE_S = 3600;

/**
 * @param {{ templateDir: string, publicDir: string, iconDir: string,
 *   values: Map<string, { value: string, colour: boolean }> }} where
 * @returns {{ pages: Map<string, { body: string, kind: string }>, icons: Map<string, string>, publicDir: string }}
 */
function loadConsoleAssets({ templateDir, publicDir, iconDir, values }) {
  const exposed = Object.keys(PAGES).filter((name) => fs.existsSync(path.join(publicDir, name)));
  if (exposed.length) {
    throw new Error(`console: ${publicDir} holds ${exposed.join(', ')}; a page belongs in ${templateDir}`);
  }

  const icons = new Map();
  const missing = [];
  for (const name of ICONS) {
    const file = path.join(iconDir, name);
    let stat = null;
    try { stat = fs.statSync(file); } catch { /* reported below */ }
    if (stat && stat.isFile()) icons.set(name, file);
    else missing.push(name);
  }
  if (missing.length) throw new Error(`console: ${iconDir} lacks ${missing.join(', ')}`);

  const pages = new Map();
  for (const [name, kind] of Object.entries(PAGES)) {
    let text;
    try {
      text = fs.readFileSync(path.join(templateDir, name), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    pages.set(name, { body: renderPage(text, name, values), kind });
  }
  return { pages, icons, publicDir };
}

/**
 * The console frontend: the rendered pages, the icons, and app/public/ as it is.
 * @param {import('express').Router} app  an express app or router
 * @param {ReturnType<typeof loadConsoleAssets>} assets
 * @param {{ assetVersion: string }} options
 */
function mountConsoleAssets(app, { pages, icons, publicDir }, { assetVersion }) {
  const index = pages.get('index.html');
  const indexBody = index ? stampAssetVersion(index.body, assetVersion) : null;
  app.get(['/', '/index.html'], (req, res) => {
    if (indexBody === null) {
      res.status(500).send('index unavailable');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(indexBody);
  });

  for (const [name, { body, kind }] of pages) {
    if (name === 'index.html') continue;
    app.get(`/${name}`, (req, res) => {
      res.setHeader('Cache-Control', kind === 'html' ? 'no-store' : `public, max-age=${ASSET_MAX_AGE_S}`);
      res.type(TYPES[kind]).send(body);
    });
  }

  // Only the listed icons, whatever else a path under icons/ spells.
  app.get('/icons/:name', (req, res) => {
    const file = icons.get(String(req.params.name));
    if (!file) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(file, { maxAge: ASSET_MAX_AGE_S * 1000 });
  });

  for (const [route, mod] of Object.entries(PACKAGE_FILES)) {
    const file = require.resolve(mod);
    app.get(route, (req, res) => res.sendFile(file, { maxAge: PACKAGE_MAX_AGE_S * 1000 }));
  }

  app.use(express.static(publicDir, {
    // The entry document is a rendered page (above), never a file here.
    index: false,
    maxAge: ASSET_MAX_AGE_S * 1000,
    setHeaders(res, filePath) {
      // The HTML app-shell must never be cached behind HA ingress. Ingress serves
      // it Content-Encoding: deflate WITHOUT Vary and adds X-Content-Type-Options:
      // nosniff; if the browser replays a stale cached copy, Safari/WebKit can't
      // re-inflate it and — with nosniff blocking any fallback — DOWNLOADS the
      // document instead of rendering it, leaving the ingress iframe blank (endless
      // spinner). A restart/auto-update just refreshes that poisoned entry, so a
      // page reload never recovers. Assets keep their long cache; only the entry
      // document is forced to revalidate every load.
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }));
}

module.exports = { ICONS, PACKAGE_FILES, loadConsoleAssets, mountConsoleAssets };
