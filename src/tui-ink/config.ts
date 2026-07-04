/**
 * harness.json — transparent per-workspace config for the deep-research
 * example.
 *
 * Precedence at read time:   CLI flag > env var > harness.json > default.
 * Precedence at write time:  env-set secrets are NEVER persisted to disk;
 *                            everything else roundtrips through harness.json.
 *
 * Storage shape is intentionally small and scoped — see `Config` below.
 * Writes are atomic (tmp-file + rename). First save in a git repo auto-
 * appends the file to `.gitignore`; the caller gets back a flag that can
 * be shown in a toast so the user knows what landed on disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePath } from './path-utils';

export interface ConfigSources {
  /** Where per-query run-dirs (report.md + annexure-N.md) and the session
   *  trace.jsonl get written. Default = process.cwd() at boot. This is
   *  harness config — NOT a per-app config object. */
  outputDir?: string;
}

/** Per-app stored config, keyed by `manifest.name` → the app's config object
 *  (whatever the app's `configSchema` declares; e.g. `{ corpusPath }`,
 *  `{ tavilyKey }`). The harness never reads inside these objects — it
 *  whole-replaces an app's entry and hands it to the registry, which
 *  validates against the app's `configSchema` on enable. Secrets (e.g.
 *  `tavilyKey`) live here verbatim; env-provided secrets win at the app
 *  factory and are never written back. */
export type ConfigApps = Record<string, Record<string, unknown>>;

export interface ConfigDefaults {
  reasoningMode: 'flat' | 'deep';
  /** Run effort preset — the session default for the composer's effort control
   *  (pure policy: budget + planner breadth + recovery cap). @default 'high' */
  effort: 'low' | 'medium' | 'high';
  maxTurns: number;
}

export interface ConfigModel {
  /** Filesystem path OR catalog id (e.g. `qwen3.5-4b-q4`). Resolution is
   *  the caller's concern — config just stores whatever the user typed. */
  path?: string;
  reranker?: string;
  /** LLM context window size. Null/undefined falls through to CLI/env/default. */
  nCtx?: number;
}

export interface Config {
  version: 1;
  sources: ConfigSources;
  /** Per-app stored config, keyed by `manifest.name`. The harness seeds
   *  `configStore` from this on boot (loop over entries) and whole-replaces
   *  an app's entry on `set_app_config`. Persisted under `apps[name]`. */
  apps: ConfigApps;
  defaults: ConfigDefaults;
  model: ConfigModel;
}

/** Which layer supplied a given harness-level field — used for composer UI
 *  hints. Per-app config lives in `Config.apps` and carries no origin
 *  tracking (apps validate their own config at enable time). */
export interface ConfigOrigin {
  reasoningMode: 'cli' | 'file' | 'default';
  modelPath: 'cli' | 'file' | 'default';
  reranker: 'cli' | 'file' | 'default';
  nCtx: 'cli' | 'env' | 'file' | 'default';
  outputDir: 'cli' | 'file' | 'default';
}

export interface LoadedConfig {
  config: Config;
  origin: ConfigOrigin;
  path: string;
  /** true iff harness.json existed on disk and was read successfully. */
  loadedFromFile: boolean;
}

export interface CliOverrides {
  reasoningMode?: 'flat' | 'deep';
  modelPath?: string;
  reranker?: string;
  nCtx?: number;
  outputDir?: string;
}

export interface SaveResult {
  path: string;
  /** true iff this save appended `harness.json` to `.gitignore` during this
   *  call. Only ever true on the very first save in a git repo. */
  gitignored: boolean;
  /** Fields that were IN the patch but deliberately skipped (env won). */
  skipped: string[];
}

// ── Defaults ────────────────────────────────────────────────────────

function builtinDefaults(): Config {
  return {
    version: 1,
    sources: {},
    apps: {},
    defaults: {
      reasoningMode: 'flat',
      effort: 'high',
      maxTurns: 10,
    },
    model: {},
  };
}

// ── Load ────────────────────────────────────────────────────────────

function readFileIfExists(p: string): Config | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config> & { version?: number };
    if (parsed.version !== 1) {
      // Future: migrate older versions. For now, ignore and rebuild.
      return null;
    }
    const defaults = builtinDefaults();
    return {
      version: 1,
      sources: { ...defaults.sources, ...(parsed.sources ?? {}) },
      apps: { ...defaults.apps, ...(parsed.apps ?? {}) },
      defaults: { ...defaults.defaults, ...(parsed.defaults ?? {}) },
      model: { ...defaults.model, ...(parsed.model ?? {}) },
    };
  } catch {
    return null;
  }
}

/** Resolve path-shaped string values in one app's config object, with no
 *  per-app name knowledge. A value is treated as a path when its property
 *  name ends in "Path" (case-insensitive) OR the string starts with `~`,
 *  `/`, or `.` — the same boundary-resolve discipline the harness-level
 *  path fields use. Non-string / non-path values pass through untouched. */
function resolveAppConfigPaths(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (
      typeof value === 'string' &&
      value !== '' &&
      (/path$/i.test(key) || /^[~/.]/.test(value))
    ) {
      out[key] = resolvePath(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig(
  configPath: string,
  cli: CliOverrides,
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  const resolvedPath = path.resolve(configPath);
  const fromFile = readFileIfExists(resolvedPath);
  const base = fromFile ?? builtinDefaults();

  const envNCtxStr = env.LLAMA_CTX_SIZE?.trim();
  const envNCtx = envNCtxStr && /^\d+$/.test(envNCtxStr)
    ? parseInt(envNCtxStr, 10)
    : undefined;

  // ── Merge with precedence: CLI > env > file > default ──
  // Path-shaped fields (outputDir, modelPath) get resolved through
  // resolvePath: ~ expansion + relative→absolute. Idempotent on
  // already-absolute paths. Defensive against stale harness.json values
  // written before the boundary-resolve pattern landed (literal "~").
  const rawOutputDir = cli.outputDir ?? base.sources.outputDir;
  const outputDir = rawOutputDir ? resolvePath(rawOutputDir) : undefined;
  const reasoningMode =
    cli.reasoningMode ?? base.defaults.reasoningMode ?? 'flat';
  const rawModelPath = cli.modelPath ?? base.model.path;
  const modelPath = rawModelPath ? resolvePath(rawModelPath) : undefined;
  const reranker = cli.reranker ?? base.model.reranker;
  const nCtx = cli.nCtx ?? envNCtx ?? base.model.nCtx;

  // Per-app config passes through verbatim, with path-shaped string values
  // resolved generically (no app-name knowledge): any property whose name
  // ends in "Path" or whose value looks like a filesystem path (~ / . prefix)
  // gets ~-expanded + made absolute, matching the harness-level path fields.
  const apps: ConfigApps = {};
  for (const [name, cfg] of Object.entries(base.apps)) {
    apps[name] = resolveAppConfigPaths(cfg);
  }

  const config: Config = {
    version: 1,
    sources: { outputDir },
    apps,
    defaults: {
      reasoningMode,
      effort: base.defaults.effort,
      maxTurns: base.defaults.maxTurns,
    },
    model: { path: modelPath, reranker, nCtx },
  };

  const origin: ConfigOrigin = {
    reasoningMode: cli.reasoningMode
      ? 'cli'
      : fromFile?.defaults.reasoningMode
        ? 'file'
        : 'default',
    modelPath: cli.modelPath ? 'cli' : fromFile?.model.path ? 'file' : 'default',
    reranker: cli.reranker ? 'cli' : fromFile?.model.reranker ? 'file' : 'default',
    nCtx: cli.nCtx !== undefined
      ? 'cli'
      : envNCtx !== undefined
        ? 'env'
        : fromFile?.model.nCtx !== undefined
          ? 'file'
          : 'default',
    outputDir: cli.outputDir
      ? 'cli'
      : fromFile?.sources.outputDir
        ? 'file'
        : 'default',
  };

  return { config, origin, path: resolvedPath, loadedFromFile: !!fromFile };
}

// ── Save ────────────────────────────────────────────────────────────

/** Writes `harness.json` atomically with a tmp-file-and-rename.
 *
 *  Per-app config (`patch.apps`) is read-modify-written into the existing
 *  `apps` map: each app name in the patch WHOLE-REPLACES that app's config
 *  object, leaving other apps untouched. An empty object (`{}`) is a valid
 *  whole-replace meaning "this app has no config" (clear semantics) — the
 *  key is kept so a re-enable still sees an entry. Harness-level fields
 *  (`sources.outputDir`) keep their empty-string-clears-the-key rule. */
export function saveConfig(
  patch: Partial<Config>,
  configPath: string,
  // env reserved for future precedence rules; secrets are no longer dropped
  // here — env fallback for a given key (e.g. TAVILY_API_KEY) lives in the
  // owning app's factory, not the harness config layer.
  _env: NodeJS.ProcessEnv = process.env,
): SaveResult {
  const resolvedPath = path.resolve(configPath);
  const current = readFileIfExists(resolvedPath) ?? builtinDefaults();

  const skipped: string[] = [];
  const nextSources: ConfigSources = {
    ...current.sources,
    ...(patch.sources ?? {}),
  };
  // Empty string = explicit clear. Delete the key rather than persisting ''.
  if (patch.sources?.outputDir === '') delete nextSources.outputDir;

  // Per-app config: whole-replace each named app's object (read-modify-write
  // the map). Other apps' entries are preserved.
  const nextApps: ConfigApps = { ...current.apps };
  for (const [name, cfg] of Object.entries(patch.apps ?? {})) {
    nextApps[name] = { ...cfg };
  }

  const next: Config = {
    version: 1,
    sources: nextSources,
    apps: nextApps,
    defaults: { ...current.defaults, ...(patch.defaults ?? {}) },
    model: { ...current.model, ...(patch.model ?? {}) },
  };

  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = resolvedPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, resolvedPath);

  const gitignored = maybeAppendGitignore(resolvedPath);
  return { path: resolvedPath, gitignored, skipped };
}

/** If CWD (or an ancestor) is a git repo, append `harness.json` to the
 *  nearest `.gitignore` iff the file isn't already ignored. Returns true
 *  when a write happened; false if we didn't touch the file (not a repo,
 *  or already ignored, or IO failure — all benign). Called on EVERY save,
 *  but only ever mutates on the first call per repo. */
function maybeAppendGitignore(configFilePath: string): boolean {
  try {
    const repoRoot = findGitRoot(path.dirname(configFilePath));
    if (!repoRoot) return false;
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const relative = path
      .relative(repoRoot, configFilePath)
      .replace(/\\/g, '/');
    const existing = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf8')
      : '';
    // Match if the file is already listed verbatim, as a filename-only entry,
    // or via a wildcard like `harness.json` anywhere in the file.
    const name = path.basename(configFilePath);
    const needle = new RegExp(
      `(^|\\n)\\s*(${escapeRe(relative)}|${escapeRe(name)})\\s*(\\n|$)`,
    );
    if (needle.test(existing)) return false;
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, prefix + relative + '\n');
    return true;
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findGitRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
