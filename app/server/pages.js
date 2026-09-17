'use strict';

// The console's own files carry the engine's names and colours as placeholders,
// `{{productName}}` or `{{theme.ui.accent}}`, filled in once when the server
// starts. The browser gets finished files: nothing is templated client-side.
//
// Each value is escaped for the file it goes into, on top of the checks the
// names and colours already passed (branding.js, theme.js). A placeholder the
// core does not know, or a `{{` that is not a placeholder, stops the start.
//
// Dependency-free: the startup placeholder renders its page with it too.

const path = require('node:path');
const { accentRgb } = require('./theme');

// file -> how a value is written into it
const PAGES = Object.freeze({
  'index.html': 'html',
  'starting.html': 'html',
  'app.js': 'js',
  'styles.css': 'css',
  'manifest.webmanifest': 'json',
});

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\}\}/g;

const hex4 = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESCAPE = {
  html: (value) => value.replace(/[&<>"']/g, (c) => HTML[c]),
  // Inside a quoted or template string of any kind, and never able to end a
  // script element.
  js: (value) => JSON.stringify(value).slice(1, -1).replace(/['`$<\u2028\u2029]/g, hex4),
  json: (value) => JSON.stringify(value).slice(1, -1).replace(/[<\u2028\u2029]/g, hex4),
  // A style sheet takes colours only; they are written as they are.
  css: (value) => value,
};

/**
 * The values the pages may use.
 * @param {{ branding: Record<string, string>, theme: Record<string, Record<string, string>>,
 *   console?: { windowName: string, updateCommand: string } }} sources
 *   `console` is absent where the adapter is not loaded (the startup placeholder).
 * @returns {Map<string, { value: string, colour: boolean }>}
 */
function pageValues({ branding, theme, console: agentConsole }) {
  const values = new Map();
  for (const [key, value] of Object.entries(branding)) values.set(key, { value, colour: false });
  if (agentConsole) {
    values.set('console.windowName', { value: agentConsole.windowName, colour: false });
    values.set('console.updateCommandName', { value: path.basename(agentConsole.updateCommand), colour: false });
  }
  for (const [section, colours] of Object.entries(theme)) {
    for (const [key, value] of Object.entries(colours)) values.set(`theme.${section}.${key}`, { value, colour: true });
  }
  values.set('theme.ui.accentRgb', { value: accentRgb(theme), colour: true });
  return values;
}

/**
 * @param {string} text  the file as shipped
 * @param {string} name  its file name, one of PAGES
 * @param {Map<string, { value: string, colour: boolean }>} values
 * @returns {string} the file with every placeholder filled in
 */
function renderPage(text, name, values) {
  const kind = PAGES[name];
  if (!kind) throw new Error(`pages: ${name} is not a console page`);
  if (text.replace(PLACEHOLDER, '').includes('{{')) {
    throw new Error(`pages: ${name} has a "{{" that is not a placeholder`);
  }
  return text.replace(PLACEHOLDER, (_match, key) => {
    const entry = values.get(key);
    if (!entry) throw new Error(`pages: ${name} uses {{${key}}}, which the core does not provide`);
    if (kind === 'css' && !entry.colour) throw new Error(`pages: ${name} uses {{${key}}}; a style sheet takes colours only`);
    return ESCAPE[kind](entry.value);
  });
}

module.exports = { PAGES, PLACEHOLDER, pageValues, renderPage };
