/**
 * Model cache root for reasoning.run.
 *
 * The catalog + downloader + slot layout now live in the platform
 * (`@lloyal-labs/rig/node`: `resolveModel` / `provisionAppModels` / `MODEL_CATALOG`,
 * fail-closed sha256 fetch, `models/<role>/<id>.gguf` slots). All reasoning.run keeps
 * of its old `src/models.ts` is the cache ROOT it hands rig as `projectRoot` — its
 * shared, packaged-app-writable XDG cache (NOT the per-project `./models/` the
 * templates use). rig appends `models/<role>/<id>.gguf` under it.
 *
 * This is the old `cacheDir()` base minus the trailing `/models` rig now appends,
 * so weights still land in `$XDG_CACHE_HOME/lloyal/models/<role>/<id>.gguf` (default
 * `~/.cache/lloyal/models/...`). Honoring `XDG_CACHE_HOME` here is what keeps the
 * packaged desktop app (Artifact) working with zero change — it redirects the root
 * to a writable `<userData>/cache`.
 */

import * as os from "node:os";
import * as path from "node:path";

/** XDG-compliant cache root reasoning.run hands rig as `projectRoot`. Respects
 *  `XDG_CACHE_HOME`; otherwise `~/.cache/lloyal/`. rig writes weights to
 *  `<root>/models/<role>/<id>.gguf`. */
export function modelsRoot(): string {
  const base = process.env.XDG_CACHE_HOME;
  return base ? path.join(base, "lloyal") : path.join(os.homedir(), ".cache", "lloyal");
}
