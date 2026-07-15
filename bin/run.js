#!/usr/bin/env node
/**
 * reasoning.run — entry point for `npx reasoning.run`.
 *
 * Loads the pre-built ESM bundle. Source is not shipped — see
 * `package.json` `files` whitelist. Build with `npm run build`
 * (also invoked automatically on `npm publish` via prepublishOnly).
 */

import("../dist/bundle.mjs")
  .then((m) => m.runMain())
  .catch((err) => {
    process.stderr.write(`Error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
