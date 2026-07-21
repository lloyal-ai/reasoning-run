#!/usr/bin/env node
/**
 * reasoning.run served-host runner — `node bin/serve.js` boots the wss front door
 * (Placement B: one resident model → N Sessions over `ws`).
 *
 * Loads the pre-built ESM bundle (dist/serve.mjs), which esbuild produces with the `.eta`
 * prompts inlined + the harness bundled. Build with `npm run build:serve`. The bundle
 * self-executes (`main(...)` runs on import). Config via env: LLOYAL_MODEL, LLOYAL_RERANKER,
 * PORT, MAX_SESSIONS, LLOYAL_NCTX.
 */
import("../dist/serve.mjs");
