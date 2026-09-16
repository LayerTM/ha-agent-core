'use strict';

// Catches real bugs (undefined or unused bindings, shadowing, unreachable code);
// deliberately no formatting rules.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    // app/ and ha-tools/ carry their own lint configuration and CI job.
    ignores: ['node_modules/**', 'dist/**', 'app/**', 'ha-tools/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-shadow': 'error',
    },
  },
];
