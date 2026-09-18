'use strict';

// One section of the changelog says a thing once. Two `### Fixed` headings under
// the same version is not a style complaint: a reader looking for what was fixed
// finds the first list and stops, and the entries under the second are invisible
// to them.
//
// This is a gate rather than a habit because the habit already failed twice —
// the headings were consolidated by hand once, and grew apart again in the very
// next pair of merges. Whoever merges is the wrong place for the check: two
// branches that each add a correct section produce the duplicate only once they
// are both on main, which is exactly where a build can see it and a review of
// either branch cannot.
//
// The rule is discovered from the file, not listed here: no `##` version heading
// repeats, and within one version section no `###` heading repeats. Nothing knows
// the word "Fixed".

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const CHANGELOG = path.join(__dirname, '..', 'CHANGELOG.md');

// Every repeated heading in `text`, as a message naming where it repeats.
// Fenced code is skipped: a `###` inside a block quote of a file is not a
// heading of this document.
function repeatedHeadings(text) {
  const findings = [];
  const versions = new Map();
  let section = '(before the first version heading)';
  let seen = new Map();
  let fenced = false;
  const start = (name) => {
    if (seen.size > 0) seen = new Map();
    section = name;
  };
  text.split('\n').forEach((line, i) => {
    const at = i + 1;
    if (/^```/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const version = /^## +(.+?) *$/.exec(line);
    if (version) {
      const name = version[1];
      if (versions.has(name)) findings.push(`line ${at}: version ${name} is already a section (line ${versions.get(name)})`);
      else versions.set(name, at);
      start(name);
      return;
    }
    const heading = /^### +(.+?) *$/.exec(line);
    if (!heading) return;
    const name = heading[1];
    if (seen.has(name)) findings.push(`line ${at}: ${section} already has a "${name}" heading (line ${seen.get(name)})`);
    else seen.set(name, at);
  });
  return findings;
}

test('no heading repeats inside one version section of the changelog', () => {
  assert.deepEqual(repeatedHeadings(fs.readFileSync(CHANGELOG, 'utf8')), []);
});

// The control. A gate that cannot fail is not a gate, and this one is read by
// nobody until the day it should fire — so the day it should fire is rehearsed
// here, on text shaped exactly like the merge that produced the real duplicate.
test('the check reports the duplicate it exists for, and only where it is one', () => {
  const duplicated = [
    '# Changelog', '', '## [Unreleased]', '', '### Fixed', '', '- one', '',
    '### Fixed', '', '- two', '', '## [0.7.0] - 2026-09-18', '', '### Fixed', '', '- old', '',
  ].join('\n');
  const findings = repeatedHeadings(duplicated);
  assert.equal(findings.length, 1, findings.join('; '));
  assert.match(findings[0], /line 9: \[Unreleased\] already has a "Fixed" heading \(line 5\)/);

  // The same heading in a DIFFERENT version section is not a repeat — that is
  // the normal shape of a changelog and must stay silent.
  assert.deepEqual(repeatedHeadings([
    '## [Unreleased]', '', '### Fixed', '', '- one', '', '## [0.7.0]', '', '### Fixed', '', '- old',
  ].join('\n')), []);

  // A repeated version heading is the same defect one level up.
  assert.equal(repeatedHeadings(['## [0.7.0]', '', '## [0.7.0]', ''].join('\n')).length, 1);

  // A heading inside a fenced block is quoted text, not a section of this file.
  assert.deepEqual(repeatedHeadings([
    '## [Unreleased]', '', '### Fixed', '', '```md', '### Fixed', '```', '',
  ].join('\n')), []);
});
