#!/usr/bin/env node
/**
 * reasoning.run — entry point for `npx reasoning.run`.
 *
 * Ships TypeScript source directly and runs it through tsx's CJS
 * register hook. Startup overhead from on-demand transpilation is
 * ~1s, which is nothing next to the model-load + research work
 * that follows. This keeps the build story at zero — no tsc,
 * no bundler, no emit directory.
 */

require('tsx/cjs/api').register();
require('tsx/esm/api').register();
require('../src/main.ts');
