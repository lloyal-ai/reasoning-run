#!/usr/bin/env node
/**
 * reasoning.run — entry point for `npx reasoning.run`.
 *
 * Loads the pre-built ESM bundle (dist/bundle.mjs) — self-contained, with
 * the .eta prompts inlined at build time, for a fast dependency-free start.
 * The TS source ALSO ships (`src` is in `package.json` `files`) so consumers
 * can import the `.` / `./protocol` / `./state` subpaths and bundle from
 * source. Build with `npm run build` (also run on publish via prepublishOnly).
 */

import("../dist/bundle.mjs")
  .then((m) => m.runMain())
  .catch((err) => {
    process.stderr.write(`Error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
