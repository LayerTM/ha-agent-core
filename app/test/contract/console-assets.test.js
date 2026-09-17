'use strict';

// The console's pages are rendered once, with every value escaped for the file
// it goes into; the add-on's icons are required; the templates as shipped are
// never served.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const { PAGES, pageValues, renderPage } = require('../../server/pages');
const { ICONS, loadConsoleAssets, mountConsoleAssets } = require('../../server/console-assets');
const { NEUTRAL, accentRgb } = require('../../server/theme');
const { NEUTRAL_BRANDING } = require('../fixtures/neutral-adapter');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-console-assets-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CONSOLE = { windowName: 'agent', updateCommand: '/usr/local/bin/update-neutral' };
const VALUES = pageValues({ branding: NEUTRAL_BRANDING, theme: NEUTRAL, console: CONSOLE });
const LS = String.fromCharCode(0x2028);

// Values no real add-on would pass the checks with, to prove the escaping on its own.
function hostile(value) {
  const values = new Map(VALUES);
  values.set('productName', { value, colour: false });
  return values;
}

test('the values: every name, the console\'s tab and updater, every colour and the accent channels', () => {
  const expected = {
    ...NEUTRAL_BRANDING,
    'console.windowName': 'agent',
    'console.updateCommandName': 'update-neutral',
    'theme.ui.accentRgb': accentRgb(NEUTRAL),
  };
  for (const [section, colours] of Object.entries(NEUTRAL)) {
    for (const [key, colour] of Object.entries(colours)) expected[`theme.${section}.${key}`] = colour;
  }
  assert.deepEqual(Object.fromEntries([...VALUES].map(([k, v]) => [k, v.value])), expected);
  for (const [key, { colour }] of VALUES) assert.equal(colour, key.startsWith('theme.'), key);
  const standalone = pageValues({ branding: NEUTRAL_BRANDING, theme: NEUTRAL });
  assert.ok(!standalone.has('console.windowName') && !standalone.has('console.updateCommandName'));
});

test('a page gets its placeholders filled in and nothing else changed', () => {
  const text = '<title>{{productName}}</title>\n<b>{{tabGlyph}} {{agentName}}</b> {{cliName}} `{{console.updateCommandName}}` {not} {{{x}';
  assert.throws(() => renderPage(text, 'index.html', VALUES), /has a "\{\{" that is not a placeholder/);
  assert.equal(
    renderPage('<title>{{productName}}</title>\n<b>{{tabGlyph}} {{agentName}}</b> {{cliName}} `{{console.updateCommandName}}` {not} }}', 'index.html', VALUES),
    '<title>Neutral Agent</title>\n<b>◆ Neutral</b> Neutral CLI `update-neutral` {not} }}',
  );
  assert.equal(renderPage('no placeholders at all\n', 'app.js', VALUES), 'no placeholders at all\n');
  assert.equal(
    renderPage(':root { --accent: {{theme.ui.accent}}; --glow: rgba({{theme.ui.accentRgb}}, .12); }', 'styles.css', VALUES),
    `:root { --accent: ${NEUTRAL.ui.accent}; --glow: rgba(${accentRgb(NEUTRAL)}, .12); }`,
  );
});

test('an unknown placeholder, a stray "{{", a name in a style sheet or an unknown file stops the render', () => {
  assert.throws(() => renderPage('{{productname}}', 'index.html', VALUES), /uses \{\{productname\}\}, which the core does not provide/);
  assert.throws(() => renderPage('{{theme.ui}}', 'app.js', VALUES), /uses \{\{theme\.ui\}\}/);
  for (const stray of ['{{ productName }}', '{{productName}', '{{', 'a{{b-c}}']) {
    assert.throws(() => renderPage(stray, 'index.html', VALUES), /not a placeholder/, stray);
  }
  assert.throws(() => renderPage('a::after { content: "{{productName}}" }', 'styles.css', VALUES), /a style sheet takes colours only/);
  assert.throws(() => renderPage('{{productName}}', 'other.html', VALUES), /other\.html is not a console page/);
  assert.deepEqual(PAGES, {
    'index.html': 'html', 'starting.html': 'html', 'app.js': 'js', 'styles.css': 'css', 'manifest.webmanifest': 'json',
  });
});

test('in a page a value cannot open markup or leave an attribute', () => {
  const out = renderPage('<p title="{{productName}}">{{productName}}</p>', 'index.html', hostile(`"><script>'&`));
  assert.equal(out, '<p title="&quot;&gt;&lt;script&gt;&#39;&amp;">&quot;&gt;&lt;script&gt;&#39;&amp;</p>');
});

test('in a script a value stays inside any kind of string and cannot end the script element', () => {
  const nasty = `'"\`\${process.exit(9)}\\</script>${LS}x`;
  const source = "[ '{{productName}}', \"{{productName}}\", `{{productName}}`, `a ${'b'} {{productName}}` ]";
  const out = renderPage(source, 'app.js', hostile(nasty));
  assert.ok(!out.includes('</script'), out);
  assert.ok(!out.includes(LS), 'no raw line separator');
  assert.deepEqual([...vm.runInNewContext(out)], [nasty, nasty, nasty, `a b ${nasty}`]);
  assert.equal(renderPage("'{{tabGlyph}} {{agentName}}'", 'app.js', VALUES), "'◆ Neutral'", 'ordinary names stay as they are');
});

test('in the manifest a value stays one JSON string', () => {
  const nasty = `"}, "x": "</script>${LS}`;
  const out = renderPage('{ "name": "{{productName}}", "background_color": "{{theme.ui.appBackground}}" }', 'manifest.webmanifest', hostile(nasty));
  assert.deepEqual(JSON.parse(out), { name: nasty, background_color: NEUTRAL.ui.appBackground });
  assert.ok(!out.includes('</script') && !out.includes(LS));
});

// A console tree: public/ with the given files, and the adapter's icons.
function consoleTree(files, icons = ICONS) {
  const dir = fs.mkdtempSync(path.join(TMP, 'tree-'));
  const publicDir = path.join(dir, 'public');
  const iconDir = path.join(dir, 'icons');
  fs.mkdirSync(publicDir);
  fs.mkdirSync(iconDir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(publicDir, name), text);
  for (const name of icons) fs.writeFileSync(path.join(iconDir, name), `icon ${name}`);
  return { publicDir, iconDir, values: VALUES };
}

test('every icon is required from the adapter, as a file', () => {
  assert.deepEqual(ICONS, ['apple-touch-icon.png', 'favicon-32.png', 'favicon.svg', 'pwa-192.png', 'pwa-512.png']);
  const tree = consoleTree({}, ICONS.filter((n) => n !== 'favicon.svg' && n !== 'pwa-512.png'));
  assert.throws(() => loadConsoleAssets(tree), /icons lacks favicon\.svg, pwa-512\.png/);
  fs.mkdirSync(path.join(tree.iconDir, 'favicon.svg'));
  fs.writeFileSync(path.join(tree.iconDir, 'pwa-512.png'), '');
  assert.throws(() => loadConsoleAssets(tree), /icons lacks favicon\.svg$/);
});

test('a page that does not render stops the load; a missing page is left out', () => {
  assert.throws(() => loadConsoleAssets(consoleTree({ 'app.js': "'{{nope}}'" })), /app\.js uses \{\{nope\}\}/);
  const { pages, icons } = loadConsoleAssets(consoleTree({ 'styles.css': 'a { color: {{theme.ui.fg}} }' }));
  assert.deepEqual([...pages.keys()], ['styles.css']);
  assert.deepEqual(pages.get('styles.css'), { body: `a { color: ${NEUTRAL.ui.fg} }`, kind: 'css' });
  assert.deepEqual([...icons.keys()], ICONS);
});

async function serve(t, tree, { withStatic = true } = {}) {
  const app = express();
  mountConsoleAssets(app, loadConsoleAssets(tree), { assetVersion: '9.9.9' });
  if (withStatic) app.use(express.static(tree.publicDir));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the rendered pages are served in place of the templates, with their types and cache rules', async (t) => {
  const tree = consoleTree({
    'index.html': '<title>{{productName}}</title><script src="app.js"></script><link href="styles.css">',
    'starting.html': '<title>{{productName}} — starting</title>',
    'app.js': "const glyph = '{{tabGlyph}}';",
    'styles.css': ':root { --bg: {{theme.ui.bg}}; }',
    'manifest.webmanifest': '{ "name": "{{productName}}" }',
    'other.txt': 'served as it is {{productName}}',
  });
  const base = await serve(t, tree);
  const cases = [
    ['/', /^text\/html/, 'no-store', '<title>Neutral Agent</title><script src="app.js?v=9.9.9"></script><link href="styles.css?v=9.9.9">'],
    ['/index.html', /^text\/html/, 'no-store', '<title>Neutral Agent</title><script src="app.js?v=9.9.9"></script><link href="styles.css?v=9.9.9">'],
    ['/starting.html', /^text\/html/, 'no-store', '<title>Neutral Agent — starting</title>'],
    ['/app.js', /^(text|application)\/javascript/, 'public, max-age=3600', "const glyph = '◆';"],
    ['/styles.css', /^text\/css/, 'public, max-age=3600', `:root { --bg: ${NEUTRAL.ui.bg}; }`],
    ['/manifest.webmanifest', /^application\/manifest\+json/, 'public, max-age=3600', '{ "name": "Neutral Agent" }'],
  ];
  for (const [route, type, cache, body] of cases) {
    const r = await fetch(`${base}${route}`);
    assert.equal(r.status, 200, route);
    assert.match(r.headers.get('content-type'), type, route);
    assert.equal(r.headers.get('cache-control'), cache, route);
    assert.equal(await r.text(), body, route);
  }
  assert.equal(await (await fetch(`${base}/other.txt`)).text(), 'served as it is {{productName}}');
});

test('the icons come from the adapter; other paths under icons/ fall through', async (t) => {
  const tree = consoleTree({});
  fs.mkdirSync(path.join(tree.publicDir, 'icons'));
  fs.writeFileSync(path.join(tree.publicDir, 'icons', 'favicon.svg'), 'shipped in public');
  fs.writeFileSync(path.join(tree.publicDir, 'icons', 'extra.png'), 'extra');
  const base = await serve(t, tree);
  for (const name of ICONS) {
    const r = await fetch(`${base}/icons/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(await r.text(), `icon ${name}`, name);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=3600', name);
  }
  assert.equal(await (await fetch(`${base}/icons/extra.png`)).text(), 'extra');
  assert.equal((await fetch(`${base}/icons/..%2F..%2Fpublic%2Fapp.js`)).status, 404);
});

test('without an index page the entry document is a 500, as before', async (t) => {
  const base = await serve(t, consoleTree({}), { withStatic: false });
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 500);
  assert.equal(await r.text(), 'index unavailable');
});
