'use strict';

// Preloaded into ha-shot.js: stands in for playwright-core so no browser starts
// and nothing is dialled. It reports the address ha-shot would have opened.

const Module = require('node:module');

const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request !== 'playwright-core') return realLoad.call(this, request, ...rest);
  return {
    chromium: {
      async launch() {
        process.stdout.write('launched\n');
        return {
          async newContext() {
            return {
              async addInitScript() {},
              async newPage() {
                return {
                  async goto(url) {
                    process.stdout.write(`goto ${url}\n`);
                    throw new Error('fake browser stops here');
                  },
                };
              },
            };
          },
          async close() {},
        };
      },
    },
  };
};
