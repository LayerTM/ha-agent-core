'use strict';

// Reproduction: a confirmed write whose only Home Assistant call failed.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CLAUDE_PROMPT_TIMEOUT_MS = '10000';
const { useAdapter } = require('../../server/adapter-contract');
const { createNeutralAdapter } = require('../fixtures/neutral-adapter');

const { adapter, state, branding } = createNeutralAdapter();
useAdapter(adapter, branding);
const core = require('../../server/prompt/run');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'core-wrepro-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('REPRO: a write whose HassTurnOn call failed resolves ok with the model text', async () => {
  state.tapes.push([
    { emit: { type: 'tool-use', id: 't1', name: 'ha.HassTurnOn' } },
    { emit: { type: 'tool-result', id: 't1', isError: true } },
    { emit: { type: 'result', structured: { text: 'Done: turned on Sandbox Test Lamp.' }, numTurns: 2, costUsd: 0 } },
  ]);
  const outcome = await core.run({
    bin: process.execPath, mode: 'write', prompt: '', cwd: TMP, mcpConfigPath: path.join(TMP, 'mcp.json'),
    intents: [{ intent: 'HassTurnOn', targets: ['light.sandbox_test_lamp'], data: {} }],
  });
  console.log('OUTCOME', JSON.stringify(outcome));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, 'Done: turned on Sandbox Test Lamp.');
});
