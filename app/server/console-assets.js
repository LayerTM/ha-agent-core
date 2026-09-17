'use strict';

// The console's pages, rendered once at start (pages.js), and the add-on's
// icons. Both are read before the console listens, so a page that does not
// render or a missing icon stops the start instead of reaching a browser.

const fs = require('node:fs');
const path = require('node:path');
const { PAGES, renderPage } = require('./pages');
const { stampAssetVersion } = require('./shell');

// The add-on ships these in app/adapter/icons/; the pages link them as icons/<name>.
const ICONS = Object.freeze(['apple-touch-icon.png', 'favicon-32.png', 'favicon.svg', 'pwa-192.png', 'pwa-512.png']);

const TYPES = { html: 'html', js: 'js', css: 'css', json: 'webmanifest' };
// As express.static served them before: the entry documents never cached,
// everything else for an hour.
const ASSET_MAX_AGE_S = 3600;

/**
 * @param {{ publicDir: string, iconDir: string, values: Map<string, { value: string, colour: boolean }> }} where
 * @returns {{ pages: Map<string, { body: string, kind: string }>, icons: Map<string, string> }}
 */
function loadConsoleAssets({ publicDir, iconDir, values }) {
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
      text = fs.readFileSync(path.join(publicDir, name), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    pages.set(name, { body: renderPage(text, name, values), kind });
  }
  return { pages, icons };
}

/**
 * Routes for the rendered pages and the icons. Mount before express.static, so
 * the shipped templates are never served as they are.
 * @param {import('express').Router} app  an express app or router
 * @param {ReturnType<typeof loadConsoleAssets>} assets
 * @param {{ assetVersion: string }} options
 */
function mountConsoleAssets(app, { pages, icons }, { assetVersion }) {
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

  app.get('/icons/:name', (req, res, next) => {
    const file = icons.get(String(req.params.name));
    if (!file) return next();
    res.sendFile(file, { maxAge: ASSET_MAX_AGE_S * 1000 });
  });
}

module.exports = { ICONS, loadConsoleAssets, mountConsoleAssets };
