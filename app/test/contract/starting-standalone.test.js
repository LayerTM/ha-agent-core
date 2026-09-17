'use strict';

// The startup placeholder runs before npm has installed anything and before the
// adapter can be trusted to load: it must start from its own files alone. It
// reads the adapter's names and colours as data when they are there, and
// renders its page with them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TEST_HOST, reportedPort, assertPortHeld } = require('../fixtures/bound-port');
const { NEUTRAL_BRANDING } = require('../fixtures/neutral-adapter');
const { NEUTRAL } = require('../../server/theme');

const SERVER = path.join(__dirname, '..', '..', 'server');

// Starts the placeholder from a tree holding only its own files, and the
// adapter's branding.json, theme.json and the page file when given (a string
// theme is written as it is). Resolves to its page and output.
async function placeholderPage(t, branding, { theme = undefined, page: pageFile = undefined } = {}) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'core-starting-'));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tree, 'server'));
  for (const name of ['starting.js', 'sources.js', 'branding.js', 'theme.js', 'pages.js']) {
    fs.copyFileSync(path.join(SERVER, name), path.join(tree, 'server', name));
  }
  fs.mkdirSync(path.join(tree, 'adapter'));
  if (branding) fs.writeFileSync(path.join(tree, 'adapter', 'branding.json'), JSON.stringify(branding));
  if (theme !== undefined) {
    fs.writeFileSync(path.join(tree, 'adapter', 'theme.json'), typeof theme === 'string' ? theme : JSON.stringify(theme));
  }
  if (pageFile !== undefined) {
    fs.mkdirSync(path.join(tree, 'templates'));
    fs.writeFileSync(path.join(tree, 'templates', 'starting.html'), pageFile);
  }
  const child = spawn(process.execPath, [path.join(tree, 'server', 'starting.js')], {
    cwd: tree,
    env: { PATH: process.env.PATH, CLAUDE_CONSOLE_PORT: '0', CLAUDE_CONSOLE_HOST: TEST_HOST, CLAUDE_CONSOLE_DEV: '1', NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let output = '';
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const port = reportedPort(output, 'Startup placeholder');
      if (port !== null) resolve(port);
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${output}`)));
  });
  const port = await listening;
  assert.ok(port > 0, output);
  await assertPortHeld(assert, port);
  const health = await fetch(`http://${TEST_HOST}:${port}/api/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false, starting: true });
  const page = await fetch(`http://${TEST_HOST}:${port}/`);
  assert.equal(page.status, 200);
  return { page: await page.text(), output };
}

test('the placeholder starts with no node_modules, no adapter and no page file', async (t) => {
  const { page, output } = await placeholderPage(t, null);
  assert.match(page, /<title>Starting…<\/title>[\s\S]*Starting the console/);
  assert.match(output, /starting page unavailable/);
  assert.match(output, /branding: .*branding\.json cannot be read.*; the page has no product name/);
});

test('without a page file, the placeholder is titled with the adapter\'s product name', async (t) => {
  const { page } = await placeholderPage(t, NEUTRAL_BRANDING);
  assert.match(page, /<title>Neutral Agent<\/title>[\s\S]*Starting the console/);
  assert.ok(page.includes(`background:${NEUTRAL.ui.bg};color:${NEUTRAL.ui.fg}`), 'the neutral colours');
});

const TEMPLATE = '<title>{{productName}} — starting</title><style>:root { --accent: {{theme.ui.accent}}; }</style>';
const ORANGE = { ...NEUTRAL, ui: { ...NEUTRAL.ui, bg: '#101010', fg: '#fafafa', accent: '#ff8800' } };

test('the page file is served with the adapter\'s names and colours filled in', async (t) => {
  const { page, output } = await placeholderPage(t, NEUTRAL_BRANDING, { theme: ORANGE, page: TEMPLATE });
  assert.equal(page, '<title>Neutral Agent — starting</title><style>:root { --accent: #ff8800; }</style>');
  assert.doesNotMatch(output, /unavailable|neutral colours/);
});

test('without a theme file the page gets the neutral colours; a broken one is reported and not used', async (t) => {
  const plain = await placeholderPage(t, NEUTRAL_BRANDING, { page: TEMPLATE });
  assert.ok(plain.page.includes(`--accent: ${NEUTRAL.ui.accent};`));
  const broken = await placeholderPage(t, NEUTRAL_BRANDING, { theme: '{"ui":', page: TEMPLATE });
  assert.ok(broken.page.includes(`--accent: ${NEUTRAL.ui.accent};`));
  assert.match(broken.output, /theme: .*theme\.json is not JSON.*; the page uses the neutral colours/);
});

test('a page that does not render, or no names to render it with, gives the plain page', async (t) => {
  const cases = [
    [NEUTRAL_BRANDING, '<title>{{console.windowName}}</title>', /uses \{\{console\.windowName\}\}, which the core does not provide/],
    [NEUTRAL_BRANDING, '<title>{{ productName }}</title>', /has a "\{\{" that is not a placeholder/],
    [null, TEMPLATE, /no names to render it with/],
  ];
  for (const [branding, pageFile, reason] of cases) {
    const { page, output } = await placeholderPage(t, branding, { theme: ORANGE, page: pageFile });
    assert.match(page, /Starting the console…<\/body>$/);
    assert.ok(page.includes('background:#101010;color:#fafafa'), 'the adapter\'s colours');
    assert.match(output, reason);
  }
});
