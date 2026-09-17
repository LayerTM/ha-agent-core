'use strict';

// The console's colours, as the add-on declares them in app/adapter/theme.json.
//
// A palette is part of a product's look, so it belongs to the add-on. Without
// the file the console uses the core's own neutral palette below: an engine
// never inherits another engine's colours by leaving the file out. A file that
// is there must be complete and valid, or nothing starts.
//
// Data, not code, and read without loading the adapter: the startup placeholder
// uses it too. Every value is a colour in one of the few forms below, so it can
// stand in a style sheet, a page or a script string as it is.

const fs = require('node:fs');
const path = require('node:path');

const THEME_FILE = path.join(__dirname, '..', 'adapter', 'theme.json');
const MAX_BYTES = 16384;

// section -> keys. `ui` feeds the style sheets and the page metadata, `terminal`
// the terminal emulator, `search` the terminal's search highlights.
const KEYS = Object.freeze({
  ui: Object.freeze([
    'bg', 'chromeHi', 'bgRaised', 'bgHover', 'fg', 'fgDim', 'accent', 'accentSoft', 'accentText',
    'border', 'danger', 'appBackground',
  ]),
  terminal: Object.freeze([
    'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionInactiveBackground',
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    'scrollbarSliderBackground', 'scrollbarSliderHoverBackground', 'scrollbarSliderActiveBackground',
  ]),
  search: Object.freeze([
    'matchBackground', 'matchBorder', 'matchOverviewRuler',
    'activeMatchBackground', 'activeMatchBorder', 'activeMatchColorOverviewRuler',
  ]),
});

// #rgb, #rrggbb, #rrggbbaa, or rgb()/rgba() with decimal channels and an alpha
// of 0, 1 or a decimal fraction.
const COLOR_RE = /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\((?:\d{1,3}, ?){2}\d{1,3}(?:, ?(?:0|1|0?\.\d{1,3}))?\))$/;
// The accent is also used with other alphas, so it must be plain #rrggbb.
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

const NEUTRAL = deepFreeze({
  ui: {
    bg: '#15171c',
    chromeHi: '#20232b',
    bgRaised: '#1b1e24',
    bgHover: 'rgba(255, 255, 255, 0.07)',
    fg: '#e6e8ec',
    fgDim: '#9aa0aa',
    accent: '#5b8def',
    accentSoft: 'rgba(91, 141, 239, 0.18)',
    accentText: '#b7ccf5',
    border: 'rgba(255, 255, 255, 0.09)',
    danger: '#f15b54',
    appBackground: '#15171c',
  },
  terminal: {
    background: '#15171c',
    foreground: '#e6e8ec',
    cursor: '#5b8def',
    cursorAccent: '#15171c',
    selectionBackground: '#5b8def50',
    selectionInactiveBackground: '#5b8def24',
    black: '#2b2e36',
    red: '#e5616b',
    green: '#78c98a',
    yellow: '#dfc070',
    blue: '#5b8def',
    magenta: '#b88be0',
    cyan: '#5fc4cf',
    white: '#c3c7cf',
    brightBlack: '#636a78',
    brightRed: '#f08a92',
    brightGreen: '#9edcab',
    brightYellow: '#ecd593',
    brightBlue: '#8cb0f4',
    brightMagenta: '#d0adec',
    brightCyan: '#8ad8e0',
    brightWhite: '#f4f5f7',
    scrollbarSliderBackground: '#ffffff1f',
    scrollbarSliderHoverBackground: '#ffffff33',
    scrollbarSliderActiveBackground: '#ffffff40',
  },
  search: {
    matchBackground: '#2e3f5a',
    matchBorder: '#3f5f96',
    matchOverviewRuler: '#4a6fae',
    activeMatchBackground: '#5b8def',
    activeMatchBorder: '#b7ccf5',
    activeMatchColorOverviewRuler: '#b7ccf5',
  },
});

function deepFreeze(value) {
  for (const inner of Object.values(value)) {
    if (inner !== null && typeof inner === 'object') deepFreeze(inner);
  }
  return Object.freeze(value);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateTheme(value) {
  if (!isObject(value)) throw new Error('theme: not an object');
  const problems = [];
  for (const section of Object.keys(value)) {
    if (!Object.hasOwn(KEYS, section)) problems.push(`${section} is not a theme section`);
  }
  for (const [section, keys] of Object.entries(KEYS)) {
    const colours = value[section];
    if (!isObject(colours)) {
      problems.push(`${section} must be an object`);
      continue;
    }
    for (const key of Object.keys(colours)) {
      if (!keys.includes(key)) problems.push(`${section}.${key} is not a theme key`);
    }
    for (const key of keys) {
      const colour = colours[key];
      if (typeof colour !== 'string' || !COLOR_RE.test(colour)) {
        problems.push(`${section}.${key} must be a colour (#rgb, #rrggbb, #rrggbbaa, rgb() or rgba())`);
      }
    }
  }
  if (isObject(value.ui) && typeof value.ui.accent === 'string' && COLOR_RE.test(value.ui.accent)
      && !ACCENT_RE.test(value.ui.accent)) {
    problems.push('ui.accent must be #rrggbb');
  }
  if (problems.length) throw new Error(`theme: ${problems.join('; ')}`);
  return deepFreeze(Object.fromEntries(Object.keys(KEYS).map((section) => [section, { ...value[section] }])));
}

// The theme file's palette, or the neutral one when there is no file.
function readTheme(file = THEME_FILE) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
      text = buffer.subarray(0, size).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code === 'ENOENT') return NEUTRAL;
    throw new Error(`theme: ${file} cannot be read: ${err.message}`, { cause: err });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`theme: ${file} is not JSON: ${err.message}`, { cause: err });
  }
  return validateTheme(value);
}

// "r, g, b" of the accent, for colours that use it with another alpha.
function accentRgb(theme) {
  const hex = theme.ui.accent.slice(1);
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ');
}

module.exports = { THEME_FILE, KEYS, NEUTRAL, validateTheme, readTheme, accentRgb };
