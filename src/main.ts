#!/usr/bin/env node
/**
 * Deep Research — CLI entry point
 *
 * TTY mode: mounts an Ink TUI with a persistent Gemini-style composer at
 * the bottom. Settings (Tavily key, corpus path, reasoning mode) live in
 * the composer and persist to `./harness.json` (or `--config <path>`).
 * Env-provided secrets (`TAVILY_API_KEY`) always win at read time and
 * are never written to disk.
 *
 * JSONL / non-TTY mode: bypasses Ink entirely; `runQuery` + `runResearchPlan`
 * compose the planner → research → answer pipeline with the same event stream.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import {
  main,
  ensure,
  createSignal,
  spawn,
  each,
  call,
} from "effection";
import type { Operation, Task } from "effection";
import {
  createContext,
  ensureBackendPack,
  probeBackendPack,
  resolveBackendPackDirSync,
} from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import {
  initAgents,
  JsonlTraceWriter,
  RerankerCtx,
  WindDown,
  CancelAgent,
  extractSpineSeed,
  reconstructBranch,
  type BranchCheckpoint,
} from "@lloyal-labs/lloyal-agents";
import type {
  App,
  TraceEvent,
  AppFactory,
  AppManifest,
} from "@lloyal-labs/lloyal-agents";
import {
  c,
  log,
  setJsonlMode,
  setVerboseMode,
  emit,
  isTTY,
} from "./primitives";
// Type-only imports from the kit's barrel are safe (types are erased).
import type { WorkflowEvent, Command, Config } from "./tui-ink";
// Runtime imports ONLY from modules that don't transitively pull Ink (ESM),
// otherwise the top-level await in yoga-wasm-web breaks the CJS loader.
import { loadConfig, saveConfig, isConfigGpu } from "./tui-ink/config";
import type { LoadedConfig } from "./tui-ink/config";
import { createBus, type EventBus } from "./tui-ink/event-bus";
import {
  createInMemoryConfigStore,
  createAppRegistry,
} from "@lloyal-labs/rig";
import type { PlanResult, Reranker } from "@lloyal-labs/rig";
import type { AppRegistry, AppConfigStore } from "@lloyal-labs/lloyal-agents";
import type { AppDescriptor } from "./tui-ink/state";
import { createReranker } from "@lloyal-labs/rig/node";
import { createWebApp } from "@lloyal-labs/web-app";
import { createCorpusApp } from "@lloyal-labs/corpus-app";

// The two first-party app factories this harness boots, paired with their
// `manifest.name`. These names bind a FACTORY to its config-store key — they
// are NOT used to route generic `set_app_config` writes (those are name-driven
// by the command payload). When app acquisition moves to the signed channel
// (harness.dev install), this static pairing goes away.
const WEB_APP = "web";
const CORPUS_APP = "corpus";

/** The KNOWN app set this harness bundles: each first-party app paired with
 *  its `manifest.name`, its zero-arg factory, and its npm package name. This is
 *  the canonical enumeration the Settings drawer renders against — every entry
 *  appears as a card whether or not it's currently registry-enabled, so a
 *  bundled-but-disabled app (e.g. corpus, which can't enable without a
 *  `corpusPath`) is still configurable. `pkg` is used to read the app's
 *  `app.json` manifest WITHOUT enabling the factory (corpus's factory throws
 *  without config). When app acquisition moves to the signed channel
 *  (harness.dev install), this static table is replaced by the installed set. */
const KNOWN_APPS: readonly {
  name: string;
  factory: AppFactory;
  pkg: string;
}[] = [
  { name: WEB_APP, factory: createWebApp, pkg: "@lloyal-labs/web-app" },
  { name: CORPUS_APP, factory: createCorpusApp, pkg: "@lloyal-labs/corpus-app" },
];

/** Resolve the app factory this harness boots for a given `manifest.name`.
 *  This is the static FACTORY binding (the only two first-party apps this
 *  build ships) — it does NOT route config writes; the write path is driven
 *  by the command's `name`. Returns undefined for unknown names. */
function factoryFor(name: string): AppFactory | undefined {
  return KNOWN_APPS.find((a) => a.name === name)?.factory;
}

/** Whether the named app's factory needs stored config to enable. The web app
 *  runs config-less (keyless search fallback); the corpus app needs a path.
 *  Used to decide whether a cleared config keeps the app enabled. */
function appRequiresConfig(name: string): boolean {
  return name !== WEB_APP;
}

/** Resolve path-shaped string values in an app-config object at the UI→harness
 *  boundary — no per-app name knowledge. A value is a path when its key ends in
 *  "Path" or the string starts with ~ / . (mirrors config.ts's load-time
 *  resolver so stored + in-memory forms agree). */
function resolveConfigPaths(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      typeof value === "string" &&
      value !== "" &&
      (/path$/i.test(key) || /^[~/.]/.test(value))
    ) {
      out[key] = resolvePath(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
import {
  runQuery,
  runResearchPlan,
  singleTaskPlan,
  createCoverageCache,
  CoverageCacheCtx,
  type Effort,
} from "./harness";
import {
  downloadIfMissing,
  resolveModelPath,
  type ModelCatalogEntry,
} from "./models";
import { RunDirSink } from "./run-dir";
import { resolvePath } from "./tui-ink/path-utils";

// ── CLI args ─────────────────────────────────────────────────────

// Default config path: harness.json in the user's working directory.
// (Previous: colocated with the script via __dirname, which doesn't exist
// in the published ESM bundle and put config in the install dir anyway.)
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "harness.json");

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    query: { type: "string" },
    model: { type: "string" },
    reranker: { type: "string" },
    corpus: { type: "string" },
    config: { type: "string" },
    gpu: { type: "string" },
    "findings-budget": { type: "string" },
    "reasoning-mode": { type: "string" },
    "n-ctx": { type: "string" },
    "output-dir": { type: "string" },
    "replay-trace": { type: "string" },
    "backend-pack": { type: "string" },
    jsonl: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const reasoningModeFlag = flags["reasoning-mode"];
if (
  reasoningModeFlag !== undefined &&
  reasoningModeFlag !== "flat" &&
  reasoningModeFlag !== "deep"
) {
  process.stderr.write(
    `Invalid --reasoning-mode: ${reasoningModeFlag}. Expected "flat" or "deep".\n`,
  );
  process.exit(1);
}

// BACKEND_DL pack behavior for headless/scripted runs. Interactive TTY
// boots offer a Download / Not now dialog instead; this flag overrides in
// both directions ("download" = auto-accept, "skip" = never probe).
const backendPackFlag = flags["backend-pack"];
if (
  backendPackFlag !== undefined &&
  backendPackFlag !== "download" &&
  backendPackFlag !== "skip"
) {
  process.stderr.write(
    `Invalid --backend-pack: ${backendPackFlag}. Expected "download" or "skip".\n`,
  );
  process.exit(1);
}

// GPU backend, validated against lloyal.node's GpuVariant union. "metal"
// gets a dedicated message — it's not a variant package; the darwin binary
// has Metal built in.
const gpuFlag = flags.gpu;
if (gpuFlag === "metal") {
  process.stderr.write(
    `Invalid --gpu: metal. Metal is automatic on macOS (built into the darwin binary) — omit --gpu, or pass cuda|vulkan on Linux/Windows ("default" = the platform binary's built-in backend).\n`,
  );
  process.exit(1);
}
if (!isConfigGpu(gpuFlag) && gpuFlag !== undefined) {
  process.stderr.write(
    `Invalid --gpu: ${gpuFlag}. Expected "cuda", "vulkan" or "default".\n`,
  );
  process.exit(1);
}

// Model path: `--model` flag or first positional. Both given and
// disagreeing is ambiguous — fail rather than pick one.
if (flags.model && positionals[0] && flags.model !== positionals[0]) {
  process.stderr.write(
    `Conflicting model paths: --model ${flags.model} vs positional ${positionals[0]}. Pass one.\n`,
  );
  process.exit(1);
}
const cliModelPath = flags.model ?? (positionals[0] || undefined);
const verbose = flags.verbose;
const cliOutputDir = flags["output-dir"];
const configPath = flags.config ?? DEFAULT_CONFIG_PATH;
const replayTracePath = flags["replay-trace"];

// ── Replay mode (regression-test + A/B harness) ──────────────────
//
// When --replay-trace is set, parse the trace file UP-FRONT so we fail loudly
// on a missing or malformed file before initializing the model. Extract the
// pre-research spine seed checkpoint + the original query — those drive the
// session trunk + auto-submit later. Force jsonlMode (no TUI; one-shot run).
//
// Determinism caveat: this MVP doesn't capture/replay sampler PRNG seeds, so
// the agent's first-token decisions can diverge from the original run. The
// reconstructed KV state is exact; what's after isn't. For rerank-quality
// regression, that's usually OK — the early tool calls (planner → first
// search) tend to land on the same prompts. Hardening to true determinism
// (sampler-seed capture in trace events + replay-side reseeding) is future
// work.
let replayCheckpoint: BranchCheckpoint | null = null;
let replayQuery: string | undefined;
if (replayTracePath) {
  if (!fs.existsSync(replayTracePath)) {
    process.stderr.write(`--replay-trace: file not found: ${replayTracePath}\n`);
    process.exit(2);
  }
  const replayEvents: TraceEvent[] = [];
  for (const line of fs.readFileSync(replayTracePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      replayEvents.push(JSON.parse(trimmed) as TraceEvent);
    } catch (err) {
      process.stderr.write(
        `--replay-trace: malformed JSONL line skipped: ${(err as Error).message}\n`,
      );
    }
  }
  try {
    replayCheckpoint = extractSpineSeed(replayEvents);
  } catch (err) {
    process.stderr.write(
      `--replay-trace: ${(err as Error).message}\n` +
        `(trace must contain a prompt:format event with role='spine' — captured by SDK ≥ replay-primitives release)\n`,
    );
    process.exit(2);
  }
  // The planner emits a prompt:format event with role='agentSuffix' whose
  // taskContent embeds the user's original query as `The query: "<text>"`.
  // (Convention from reasoning.run's planner.eta, not a framework one.)
  const plannerEvt = replayEvents.find(
    (e): e is Extract<TraceEvent, { type: "prompt:format" }> =>
      e.type === "prompt:format" &&
      "role" in e &&
      e.role === "agentSuffix" &&
      typeof (e as { taskContent?: unknown }).taskContent === "string" &&
      ((e as { taskContent: string }).taskContent.startsWith("The query:")),
  );
  if (plannerEvt) {
    const m = /The query:\s*"([^"]+)"/.exec(
      (plannerEvt as { taskContent: string }).taskContent,
    );
    if (m) replayQuery = m[1];
  }
  if (!replayQuery) {
    process.stderr.write(
      `--replay-trace: could not extract original query from trace (no planner prompt:format event matched 'The query: "..."').\n` +
        `Pass --query to override.\n`,
    );
    if (!flags.query) process.exit(2);
  }
}

// In replay mode, force jsonl (no TUI). The flag's still respected for
// non-replay runs.
const jsonlMode = flags.jsonl || replayTracePath != null;
const initialQuery = flags.query ?? replayQuery;

const nCtxFlag = flags["n-ctx"];
if (nCtxFlag !== undefined && !/^\d+$/.test(nCtxFlag)) {
  process.stderr.write(
    `Invalid --n-ctx: ${nCtxFlag}. Expected a positive integer.\n`,
  );
  process.exit(1);
}
const nCtxCli = nCtxFlag !== undefined ? parseInt(nCtxFlag, 10) : undefined;

/** Overlay the `--corpus <dir>` flag onto a freshly-loaded config's per-app
 *  map (mutates + returns it). The flag (when present) seeds the corpus app's
 *  stored `corpusPath` so a one-off `--corpus <dir>` boots the corpus app
 *  without writing harness.json — matching the prior `corpusPath` CLI
 *  override. The `--corpus` flag binds to the corpus app by definition of the
 *  flag, not by config-store routing. Resolved at the boundary. */
function applyCorpusFlag(loadedCfg: LoadedConfig): LoadedConfig {
  if (flags.corpus) {
    loadedCfg.config.apps = {
      ...loadedCfg.config.apps,
      [CORPUS_APP]: {
        ...loadedCfg.config.apps[CORPUS_APP],
        corpusPath: resolvePath(flags.corpus),
      },
    };
  }
  return loadedCfg;
}

// Snapshot the LAUNCH-time environment for config precedence. The boot
// path later injects LLOYAL_GPU into process.env to steer the native
// loader; resolving reloads against live process.env would feed our own
// injection back in as the env rung — beating a fresher harness.json
// write (/gpu) and misattributing origin. Precedence always resolves
// against what the user actually launched with.
const launchEnv: NodeJS.ProcessEnv = { ...process.env };

// Merge: CLI flag > env > harness.json > default.
const loaded = applyCorpusFlag(
  loadConfig(
    configPath,
    {
      modelPath: cliModelPath,
      reranker: flags.reranker,
      reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
      nCtx: nCtxCli,
      gpu: gpuFlag,
      outputDir: cliOutputDir,
    },
    launchEnv,
  ),
);
let liveConfig: Config = loaded.config;
let liveOrigin = loaded.origin;
const findingsMaxChars = flags["findings-budget"]
  ? parseInt(flags["findings-budget"], 10)
  : undefined;

// Resolve catalog-id / explicit path / catalog-default for each model.
// Downloads happen later, pre-Ink, via ensureFile.
const llmResolved = resolveModelPath(liveConfig.model.path, "llm");
const rerankerResolved = resolveModelPath(liveConfig.model.reranker, "reranker");
const modelPath = llmResolved.path;
const rerankModelPath = rerankerResolved.path;
const nCtx = liveConfig.model.nCtx ?? 32768;

if (jsonlMode) setJsonlMode(true);
if (verbose) setVerboseMode(true);

// Silence llama.cpp stderr in default mode.
const quietMode = !verbose && !jsonlMode;
if (quietMode) {
  try {
    fs.closeSync(2);
    fs.openSync(process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null", "w");
  } catch {
    // Non-fatal.
  }
}

const MAX_TOOL_TURNS = 10;

// ── Planner context ──────────────────────────────────────────────

/** Summarize the registered apps for the planner prompt: the source catalog
 *  the planner routes against. Lists each source's exact name, its purpose
 *  (`useWhen`), and the corpus table-of-contents (the corpus app's
 *  `source.promptData().toc`). With ≥2 sources the planner assigns each task's
 *  `app` to the source that holds it — grounded by the pre-flight coverage
 *  probe that runQuery folds into the context alongside this catalog (RFC:
 *  multi-app composition). */
function buildPlannerContext(apps: readonly App[]): string {
  if (apps.length === 0) return "";
  const lines: string[] = [
    "Knowledge sources available for this research. Assign each task's `app` to the source that holds it, using its EXACT name below; the pre-flight `Source coverage` probe (when present) is the primary signal for which source covers what.",
  ];
  for (const app of apps) {
    const protocol = app.manifest.protocol;
    lines.push("", `### ${protocol.name}`, protocol.useWhen);
    const toc = app.source.promptData()["toc"];
    if (typeof toc === "string" && toc) {
      lines.push("Files and top-level topics available in this source:", toc);
    }
  }
  return lines.join("\n");
}

// ── Known-AgentApps surfacing (Settings drawer) ──────────────────
//
// The Settings drawer renders one card per KNOWN bundled app (the KNOWN_APPS
// table), NOT just the registry-enabled ones — so a bundled-but-disabled app
// (corpus without a corpusPath) still shows up and can be configured (which
// enables it). Each card joins the app's local manifest with its SIGNED
// catalog metadata (title/iconUrl/entitlements from apps.lloyal.ai). The
// catalog is fetched once, best-effort, and cached for the process lifetime —
// display-only, so any failure falls back to manifest-only fields (title =
// protocol.name, no iconUrl, entitlements = []). buildAppDescriptors() runs
// after boot and after every registry enable/disable/config change; the result
// is forwarded to the renderer via the `apps:state` StepEvent.
//
// Manifest source: for an ENABLED app we read `registry.byName(name).manifest`
// directly. For a DISABLED app we can't construct the factory (corpus throws
// without config), so we read the package's `app.json` from disk — the same
// file the factory itself loads via `join(__dirname,'..','app.json')`. The
// read uses `createRequire(import.meta.url)` so it resolves the real package
// location in the esbuild ESM bundle, and is cached per package.

const nodeRequire = createRequire(import.meta.url);

// Per-package app.json cache: undefined = not yet attempted; null = attempted
// and failed (so we don't re-stat/re-parse on every emit). On a hit we hold the
// parsed manifest. Keyed by npm package name.
const manifestCache = new Map<string, AppManifest | null>();

/** Read a KNOWN app's `app.json` manifest from disk WITHOUT enabling it.
 *  Resolves the package's main entry via `require.resolve(pkg)` — the `.`
 *  export is the ONLY exported subpath, so `require.resolve(pkg + '/package.json')`
 *  is blocked by the package's `exports` map and CANNOT be used here. The entry
 *  resolves to `<pkgRoot>/dist/index.js`; `app.json` sits one level up at the
 *  package root (exactly where the factory reads it via
 *  `join(__dirname,'..','app.json')`). Best-effort + cached: any failure caches
 *  null and returns undefined so the caller falls back to a minimal descriptor. */
function loadKnownManifest(pkg: string): AppManifest | undefined {
  if (manifestCache.has(pkg)) return manifestCache.get(pkg) ?? undefined;
  try {
    const entry = nodeRequire.resolve(pkg);
    const appJsonPath = path.join(path.dirname(entry), "..", "app.json");
    const manifest = JSON.parse(
      fs.readFileSync(appJsonPath, "utf8"),
    ) as AppManifest;
    manifestCache.set(pkg, manifest);
    return manifest;
  } catch {
    manifestCache.set(pkg, null);
    return undefined;
  }
}

/** Shape of the public signed catalog at apps.lloyal.ai. Catalog names are
 *  SCOPED (`lloyal/web`); manifest names are short (`web`). We match by the
 *  trailing path segment. Only the display metadata is read here. */
interface CatalogEntry {
  name: string;
  metadata?: {
    title?: string;
    iconUrl?: string;
    entitlements?: string[];
  };
}
interface Catalog {
  entries: CatalogEntry[];
}

const APPS_CATALOG_URL = "https://apps.lloyal.ai/v1/catalog.json";

// Process-lifetime cache: null = never fetched; the fetch is attempted once.
// On failure we cache an empty catalog so we don't re-hit the network on every
// emit (descriptors then fall back to manifest-only fields).
let catalogCache: Catalog | null = null;

/** Fetch + cache the signed catalog once. Best-effort: any failure caches an
 *  empty catalog so subsequent emits stay manifest-only without re-fetching. */
async function getCatalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache;
  try {
    const res = await fetch(APPS_CATALOG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Partial<Catalog>;
    catalogCache = { entries: Array.isArray(json.entries) ? json.entries : [] };
  } catch {
    catalogCache = { entries: [] };
  }
  return catalogCache;
}

/** Trailing path segment of a (possibly scoped) catalog name: `lloyal/web` → `web`. */
function shortCatalogName(name: string): string {
  const i = name.lastIndexOf("/");
  return i === -1 ? name : name.slice(i + 1);
}

/** Build view-ready descriptors for every KNOWN bundled app (NOT just the
 *  registry-enabled ones), joining each app's manifest with signed catalog
 *  metadata. A disabled app still gets a card so the user can configure it.
 *  `enabled` is derived from registry membership. The manifest comes from the
 *  live registry entry when enabled, else from the package's `app.json` on
 *  disk (no factory construction — corpus's factory throws without config).
 *  Display-only — never throws on a catalog or manifest miss. */
function* buildAppDescriptors(
  registry: AppRegistry,
  configStore: AppConfigStore,
): Operation<AppDescriptor[]> {
  const catalog = yield* call(() => getCatalog());
  const byShortName = new Map<string, CatalogEntry["metadata"]>();
  for (const entry of catalog.entries) {
    byShortName.set(shortCatalogName(entry.name), entry.metadata);
  }

  const descriptors: AppDescriptor[] = [];
  for (const known of KNOWN_APPS) {
    const enabledApp = registry.byName(known.name);
    const enabled = enabledApp !== undefined;
    // Prefer the live manifest when enabled; otherwise read app.json off disk.
    const manifest = enabledApp?.manifest ?? loadKnownManifest(known.pkg);
    const meta = byShortName.get(known.name);
    const config = (yield* configStore.get(known.name)) ?? {};

    if (!manifest) {
      // Manifest unreadable (resolve/read/parse failed) — still surface a
      // minimal card so the app isn't invisible. No tools/schema/entitlements.
      descriptors.push({
        name: known.name,
        title: meta?.title ?? known.name,
        description: "",
        iconUrl: meta?.iconUrl,
        tools: [],
        entitlements: meta?.entitlements ?? [],
        configSchema: undefined,
        config,
        enabled,
      });
      continue;
    }

    descriptors.push({
      name: known.name,
      title:
        meta?.title ?? manifest.hints?.shortName ?? manifest.protocol.name,
      description: manifest.hints?.description ?? manifest.protocol.useWhen,
      iconUrl: meta?.iconUrl,
      tools: [...manifest.protocol.tools],
      entitlements: meta?.entitlements ?? [],
      configSchema: manifest.configSchema,
      config,
      enabled,
    });
  }
  return descriptors;
}

// ── Clarify helpers ──────────────────────────────────────────────

/** Render the planner's clarify questions as an assistant-style markdown
 *  message. Committed to `session.trunk` paired with the user's most recent
 *  input so subsequent planner forks attend over prior clarify rounds via KV
 *  inheritance — instead of carrying the exchange as prose in the planner's
 *  prompt context. */
function formatClarifyAsAssistantMsg(questions: readonly string[]): string {
  return [
    "I need to clarify a few things before researching:",
    "",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");
}

// ── Error helpers ────────────────────────────────────────────────

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const errorStack = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
  // The Electron utilityProcess host sets RR_BRIDGE — the harness streams its
  // WorkflowEvents over process.parentPort instead of mounting Ink/JSONL.
  const bridgeMode = !!process.env.RR_BRIDGE;
  const useInk = isTTY && !jsonlMode && !bridgeMode;

  // Pre-boot logs only in non-Ink mode — Ink mounts ASAP in TTY mode and
  // handles download/loading UI itself.
  if (!useInk && !bridgeMode) {
    log();
    log(`${c.bold}  Deep Research${c.reset}`);
    log();
  }

  // Replay-to-first-subscriber bus. Events sent between render() and Ink's
  // useEffect attachment get buffered and replayed — no timing assumptions.
  // `send` is synchronous so callbacks like downloadIfMissing.onProgress
  // can push directly.
  const uiChannel: EventBus<WorkflowEvent> = createBus<WorkflowEvent>();
  const commands = createSignal<Command, void>();
  // Graceful "Wrap up" signal — provided to the run scope via the agents WindDown
  // context; the command loop sends it on a `wrap_up` command to drain the pool to
  // a fast best-effort answer (distinct from `stop` = halt). One persistent signal;
  // each run's pool subscribes fresh on it.
  const windDown = createSignal<void, void>();
  // Per-agent cancel signal — provided to the run scope via the agents CancelAgent
  // context; the command loop sends `{agentId}` on a `cancel_agent` command to discard
  // one live research agent (halt its tool + prune its KV + terminal agent:failed).
  // One persistent signal; each run's pool subscribes fresh on it.
  const cancelAgent = createSignal<{ agentId: number }, void>();

  // CLI overrides for model paths get nulled when the user picks a path via
  // /model or /reranker — otherwise the CLI flag would clobber the user's
  // explicit slash choice on the next restart iteration.
  let cliModelOverride: string | undefined = cliModelPath;
  let cliRerankerOverride: string | undefined = flags.reranker;
  let cliGpuOverride = gpuFlag;

  // Re-load harness.json with the live CLI-override state + the `--corpus`
  // flag overlay. Used on every restart / config-write reload so the four
  // loadConfig sites stay in one place (drops the per-app config-shaped fields
  // that no longer live in CliOverrides).
  const reloadLiveConfig = (): LoadedConfig =>
    applyCorpusFlag(
      loadConfig(
        configPath,
        {
          modelPath: cliModelOverride,
          reranker: cliRerankerOverride,
          reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
          outputDir: cliOutputDir,
          nCtx: nCtxCli,
          gpu: cliGpuOverride,
        },
        // launchEnv, not process.env: applyGpuEnv injects LLOYAL_GPU below;
        // reloads must not read our own injection back as the env rung.
        launchEnv,
      ),
    );

  // Steer the native-binding load for BOTH the main context and the
  // reranker: rig's createReranker exposes no loadOptions passthrough, so
  // process.env.LLOYAL_GPU (read lazily inside lloyal.node's loadBinary at
  // createContext time) is the one lever that reaches them both. When the
  // backend was EXPLICITLY requested (flag or harness.json — not a bare
  // pre-existing env var), an unavailable variant should fail loud at boot
  // rather than silently falling back to CPU; the loader's own
  // LLOYAL_NO_FALLBACK knob does exactly that. A user-set LLOYAL_NO_FALLBACK
  // is never overridden.
  //
  // Tracks whether WE set LLOYAL_NO_FALLBACK (vs the user), so a reload
  // where the backend is no longer explicitly requested clears exactly
  // what we own and nothing else.
  let noFallbackOwned = false;
  const applyGpuEnv = (cfg: Pick<LoadedConfig, "config" | "origin">): void => {
    const gpu = cfg.config.model.gpu;
    if (gpu) {
      process.env.LLOYAL_GPU = gpu;
    } else if (process.env.LLOYAL_GPU !== undefined) {
      // Mirror the resolved config exactly: with no gpu from any rung, a
      // leftover env value (invalid at launch, or a stale self-injection
      // after config cleared) must not keep steering the native loader.
      // This is a non-fatal notice, not an error — no bus event: ui:error's
      // reducer forces uiPhase back to 'composer', which would corrupt the
      // boot phase this runs in. Plain one-shot mode keeps a stderr line
      // (nothing to corrupt there); elsewhere the resolved backend is
      // already visible via config:loaded.
      if (!useInk && !bridgeMode) {
        process.stderr.write(
          `Ignoring LLOYAL_GPU=${process.env.LLOYAL_GPU} — no valid backend configured (expected cuda|vulkan|default)\n`,
        );
      }
      delete process.env.LLOYAL_GPU;
    }
    const explicit =
      gpu !== undefined &&
      (cfg.origin.gpu === "cli" || cfg.origin.gpu === "file");
    if (explicit && process.env.LLOYAL_NO_FALLBACK === undefined) {
      process.env.LLOYAL_NO_FALLBACK = "1";
      noFallbackOwned = true;
    } else if (!explicit && noFallbackOwned) {
      delete process.env.LLOYAL_NO_FALLBACK;
      noFallbackOwned = false;
    }
  };

  // Compute initial download plan synchronously so it can be bootstrapped
  // alongside config:loaded. Reasoning: if we send download:plan via the bus
  // AFTER mount, the first paint shows the empty 'boot' tree and a later
  // frame shows the populated 'downloading' tree — Ink's clearTerminal-on-
  // shape-change leaks the pre-transition frame to scrollback (the phantom-
  // entry bug). Bootstrapping the plan means frame 1 is already in the
  // final shape; no transition for Ink to leak.
  const initialPlanEntries = [llmResolved, rerankerResolved]
    .filter((r) => r.entry !== null && !fs.existsSync(r.path))
    .map((r) => ({
      id: r.entry!.id,
      label: r.entry!.label,
      sizeBytes: r.entry!.sizeBytes,
    }));

  let inkInstance: { unmount: () => void } | null = null;
  if (useInk) {
    const mod = yield* call(
      () =>
        import("./tui-ink/render.js") as Promise<
          typeof import("./tui-ink/render.js")
        >,
    );
    // Seed with config:loaded + (optionally) download:plan so first paint
    // already reflects the final boot-phase tree shape.
    const bootstrap: WorkflowEvent[] = [
      {
        type: "config:loaded",
        config: liveConfig,
        origin: liveOrigin,
        path: loaded.path,
      },
    ];
    if (initialPlanEntries.length > 0) {
      bootstrap.push({ type: "download:plan", entries: initialPlanEntries });
    }
    inkInstance = mod.render(uiChannel, (cmd) => commands.send(cmd), bootstrap);
    yield* ensure(() => { inkInstance?.unmount(); });
  } else if (bridgeMode) {
    // Electron utilityProcess: bridge the EventBus + Command signal over the
    // parentPort MessagePort (engine ⇄ main ⇄ renderer). Same contract as Ink:
    // subscribe → post every WorkflowEvent; inbound 'command' → commands.send.
    const pp = (process as unknown as {
      parentPort: {
        postMessage(m: unknown): void;
        on(e: "message", cb: (ev: { data: unknown }) => void): void;
        start?(): void;
      };
    }).parentPort;
    uiChannel.subscribe((ev) => pp.postMessage({ t: "event", payload: ev }));
    pp.on("message", (e) => {
      const m = e.data as { t?: string; payload?: unknown };
      if (m?.t === "command") commands.send(m.payload as Command);
    });
    pp.start?.();
    // No Ink/stdin handle holds the libuv loop in bridge mode, so the suspended
    // command loop would let Node drain and exit. Keep the process alive while
    // it waits for commands; cleared on exit.
    const keepAlive = setInterval(() => {}, 1 << 30);
    process.on("exit", () => clearInterval(keepAlive));
    // Seed bootstrap exactly like Ink's render(bootstrap) does.
    uiChannel.send({
      type: "config:loaded",
      config: liveConfig,
      origin: liveOrigin,
      path: loaded.path,
    });
    if (initialPlanEntries.length > 0) {
      uiChannel.send({ type: "download:plan", entries: initialPlanEntries });
    }
    pp.postMessage({ t: "ready" });
  } else {
    // Non-TTY / JSONL: drain the bus to JSONL stdout. Synchronous subscribe
    // replays any already-buffered events immediately.
    uiChannel.subscribe((ev) => {
      emit((ev as { type: string }).type, ev as unknown as Record<string, unknown>);
    });
  }

  // ── Session-scoped trace ──────────────────────────────────────
  // One trace.jsonl per process invocation — survives /model and /reranker
  // restarts. Stays in the outer scope so the file handle isn't recreated
  // per iteration.
  const sessionOutputDir = resolvePath(
    liveConfig.sources.outputDir || process.cwd(),
  );
  fs.mkdirSync(sessionOutputDir, { recursive: true });
  const sessionTraceTs = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("Z", "");
  const sessionTracePath = path.join(
    sessionOutputDir,
    `trace-${sessionTraceTs}.jsonl`,
  );
  const sessionTraceFd = fs.openSync(sessionTracePath, "w");
  const traceWriter = new JsonlTraceWriter(sessionTraceFd);
  yield* ensure(() => {
    traceWriter.flush();
    try {
      fs.closeSync(sessionTraceFd);
    } catch {
      /* non-fatal */
    }
  });

  // ── Boot helpers (close over uiChannel, commands) ─────────────

  function* ensureFile(
    r: { path: string; entry: ModelCatalogEntry | null },
  ): Operation<string> {
    if (fs.existsSync(r.path)) return r.path;
    if (!r.entry) {
      throw new Error(
        `Model not found: ${r.path}. ` +
          `Pass --model <path> or use /model <path> to set a local .gguf file.`,
      );
    }
    const entry = r.entry;
    uiChannel.send({
      type: "download:start",
      id: entry.id,
      label: entry.label,
      sizeBytes: entry.sizeBytes,
    });
    yield* call(() =>
      downloadIfMissing(entry, {
        onProgress: (got, total, url) => {
          uiChannel.send({
            type: "download:progress",
            id: entry.id,
            got,
            total,
            url,
          });
        },
      }),
    );
    uiChannel.send({ type: "download:complete", id: entry.id });
    return r.path;
  }

  function planDownloads(
    rs: ({ path: string; entry: ModelCatalogEntry | null })[],
  ): void {
    const entries = rs
      .filter((r) => r.entry !== null && !fs.existsSync(r.path))
      .map((r) => ({
        id: r.entry!.id,
        label: r.entry!.label,
        sizeBytes: r.entry!.sizeBytes,
      }));
    if (entries.length > 0) {
      uiChannel.send({ type: "download:plan", entries });
    }
  }

  function* awaitBootRecovery(): Operation<
    | { type: "set_model_path"; path: string }
    | { type: "set_reranker_path"; path: string }
    | { type: "set_gpu"; gpu: "default" | "cuda" | "vulkan" }
    | { type: "quit" }
  > {
    for (const cmd of yield* each(commands)) {
      if (
        cmd.type === "quit" ||
        cmd.type === "set_model_path" ||
        cmd.type === "set_reranker_path" ||
        cmd.type === "set_gpu"
      ) {
        yield* each.next();
        return cmd;
      }
      yield* each.next();
    }
    return { type: "quit" };
  }

  function* awaitBackendPackDecision(): Operation<boolean> {
    for (const cmd of yield* each(commands)) {
      if (cmd.type === "accept_backend_pack") {
        yield* each.next();
        return true;
      }
      if (cmd.type === "decline_backend_pack" || cmd.type === "quit") {
        yield* each.next();
        return false;
      }
      yield* each.next();
    }
    return false;
  }

  /** Boot-time BACKEND_DL pack acquisition (design §3.3 path: consented
   *  prompt). Gates: cuda + linux + not previously declined + no cached
   *  pack. Probe failures (offline, no nvidia-smi) skip silently to the
   *  npm chain — the offer must never block a boot. On accept, the
   *  archives stream through the standard download UI and the SAME boot
   *  iteration proceeds: loadBinary resolves the fresh cache inside
   *  createContext. Decline persists model.backendPack=false. */
  function* maybeOfferBackendPack(): Operation<void> {
    if (liveConfig.model.gpu !== "cuda" || process.platform !== "linux") return;
    if (backendPackFlag === "skip") return;
    if (liveConfig.model.backendPack === false && backendPackFlag !== "download") return;
    if (resolveBackendPackDirSync()) return; // already installed

    let probe: Awaited<ReturnType<typeof probeBackendPack>>;
    try {
      probe = yield* call(() => probeBackendPack());
    } catch (err) {
      if (verbose) {
        process.stderr.write(`[backend-pack] probe skipped: ${errorMessage(err)}\n`);
      }
      return;
    }
    if (!probe.recommended) return;

    const totalBytes =
      probe.sizeBytes + (probe.needsRuntimeArchive ? probe.runtimeSizeBytes : 0);
    let accepted: boolean;
    if (backendPackFlag === "download") {
      accepted = true;
    } else if (!useInk) {
      // Headless (jsonl / bridge / non-TTY): never prompt, never download
      // unasked — one legible line, then the npm chain.
      process.stderr.write(
        `[backend-pack] ${probe.gpu?.name ?? "CUDA GPU"}: signed full-arch pack available ` +
          `(${(totalBytes / 1e9).toFixed(1)} GB). Pass --backend-pack download to install; ` +
          `continuing on the npm binary.\n`,
      );
      return;
    } else {
      uiChannel.send({
        type: "backendpack:offer",
        gpuName: probe.gpu?.name ?? "CUDA GPU",
        sizeBytes: probe.sizeBytes,
        needsRuntime: probe.needsRuntimeArchive,
        runtimeSizeBytes: probe.runtimeSizeBytes,
        reasons: probe.reasons,
      });
      accepted = yield* awaitBackendPackDecision();
    }

    if (!accepted) {
      saveConfig({ model: { backendPack: false } }, configPath);
      const reloaded = reloadLiveConfig();
      liveConfig = reloaded.config;
      liveOrigin = reloaded.origin;
      uiChannel.send({
        type: "config:updated",
        config: liveConfig,
        origin: liveOrigin,
        savedTo: reloaded.path,
        gitignored: false,
        skipped: [],
      });
      return;
    }

    const entries = [
      { id: "backend-pack", label: "CUDA backend pack", sizeBytes: probe.sizeBytes },
      ...(probe.needsRuntimeArchive
        ? [{ id: "cuda-runtime", label: "CUDA runtime libraries", sizeBytes: probe.runtimeSizeBytes }]
        : []),
    ];
    uiChannel.send({ type: "download:plan", entries });
    for (const e of entries) {
      uiChannel.send({ type: "download:start", ...e });
    }
    yield* call(() =>
      ensureBackendPack({
        includeRuntime: probe.needsRuntimeArchive,
        onProgress: (got, total, file) => {
          // ensureBackendPack labels its archives 'backend-pack' /
          // 'cuda-runtime' — the same ids planned above.
          uiChannel.send({ type: "download:progress", id: file, got, total });
        },
      }),
    );
    for (const e of entries) {
      uiChannel.send({ type: "download:complete", id: e.id });
    }
  }

  // ── Per-session restart loop ──────────────────────────────────
  // Each iteration spawns a child task that owns ctx, reranker, the agent
  // event-forwarder, and the command loop. Returning "restart" from the
  // command loop (after /model or /reranker save) ends the spawned task —
  // structured concurrency tears down everything in that scope (reranker
  // dispose, ctx dispose, forwarder halt) before the next iteration starts.
  // Returning "quit" exits main(), unwinding Ink and the trace file too.
  //
  // Ink stays mounted across restarts: the user sees the same alt-screen
  // re-enter the load phase as if it were a fresh boot, no terminal flash.

  let iteration = 0;
  while (true) {
    // On restart, re-load config (picks up the /model write the running-loop
    // handler just persisted) and refresh Ink so the new model name shows
    // during the next load phase.
    if (iteration > 0) {
      const reloaded = reloadLiveConfig();
      liveConfig = reloaded.config;
      liveOrigin = reloaded.origin;
      // Use config:loaded (no toast) — the save toast already fired in the
      // prior iteration's set_model_path / set_reranker_path handler.
      uiChannel.send({
        type: "config:loaded",
        config: liveConfig,
        origin: liveOrigin,
        path: reloaded.path,
      });
      // Re-plan downloads so the reducer transitions out of 'composer' into
      // a load phase. If nothing needs downloading, weights:start (inside
      // the boot loop) is the transition.
      const llmNext = resolveModelPath(liveConfig.model.path, "llm");
      const rerNext = resolveModelPath(liveConfig.model.reranker, "reranker");
      planDownloads([llmNext, rerNext]);
    }

    const iterCaptured = iteration;
    const task = yield* spawn(function* (): Operation<"quit" | "restart"> {
      // Resolve paths fresh — picks up any harness.json changes from a
      // prior /model write. modelName/rerankName fall back to basename
      // when there's no catalog entry (raw path).
      let llmResolvedNow = resolveModelPath(liveConfig.model.path, "llm");
      let modelPathNow = llmResolvedNow.path;
      let modelNameNow =
        llmResolvedNow.entry?.label ?? path.basename(modelPathNow).replace(/-Q\w+\.gguf$/, "");
      let rerankerResolvedNow = resolveModelPath(liveConfig.model.reranker, "reranker");
      let rerankModelPathNow = rerankerResolvedNow.path;
      let rerankNameNow =
        rerankerResolvedNow.entry?.label ?? path.basename(rerankModelPathNow).replace(/-q\w+\.gguf$/i, "");
      const nCtx = liveConfig.model.nCtx ?? 32768;

      let ctx: SessionContext | null = null;
      let reranker: Reranker | null = null;

      // First iteration uses the bootstrapped plan (no bus emit needed).
      // Subsequent iterations re-plan via the bus since paths may have
      // changed — both restart-time replan (above) and recovery-time replan
      // (catch block below) handle their own emit.
      let firstBootIteration = iterCaptured === 0;

      while (ctx === null || reranker === null) {
        let lastFailedKind: "llm" | "reranker" | "backend-pack" = "llm";
        try {
          if (!firstBootIteration) {
            planDownloads([llmResolvedNow, rerankerResolvedNow]);
          }
          firstBootIteration = false;

          lastFailedKind = "llm";
          yield* ensureFile(llmResolvedNow);

          lastFailedKind = "reranker";
          yield* ensureFile(rerankerResolvedNow);

          // Re-derive per attempt: a /gpu recovery command reloads liveConfig
          // between attempts. The env lever must be set before EITHER
          // createContext (loadBinary reads it lazily at call time) and is
          // what steers the reranker below — rig has no loadOptions passthrough.
          applyGpuEnv({ config: liveConfig, origin: liveOrigin });
          const gpuNow = liveConfig.model.gpu;

          // BACKEND_DL pack: probe + consented download (or headless flag)
          // BEFORE the context loads — loadBinary resolves the pack cache
          // ahead of the npm chain, so an accepted pack serves THIS boot.
          // Probe errors are swallowed inside (the offer never blocks boot);
          // only post-ACCEPT failures (download/sha/extract) throw to the
          // catch below — label them so the error screen doesn't blame the
          // reranker. A failed install writes no completion marker, so the
          // offer re-fires on the next boot: relaunch IS the retry path.
          lastFailedKind = "backend-pack";
          yield* maybeOfferBackendPack();

          lastFailedKind = "llm";
          uiChannel.send({ type: "weights:start", label: `Loading ${modelNameNow}…` });
          ctx = yield* call(() =>
            createContext(
              {
                modelPath: modelPathNow,
                nCtx,
                nSeqMax: 64,
                typeK: "q4_0",
                typeV: "q4_0",
              },
              // Explicit variant beats env inside lloyal.node; the reranker
              // (no loadOptions passthrough in rig) rides LLOYAL_GPU set above.
              gpuNow ? { gpuVariant: gpuNow } : undefined,
            ),
          );

          lastFailedKind = "reranker";
          uiChannel.send({ type: "weights:label", label: `Loading ${rerankNameNow}…` });
          // createReranker is an Effection resource() — yield it directly; it
          // owns its model context and disposes on this scope's exit.
          reranker = yield* createReranker(rerankModelPathNow, {
            // 10, not 8: the rerank architecture spends 2 leases on
            // trunk + queryBranch; 10 keeps 8 effective scoring leaves
            // (rig's default — this override previously pinned the old 8
            // and silently shrank batches to 6 leaves).
            nSeqMax: 10,
            nCtx: 16384,
          });
        } catch (err) {
          if (ctx) {
            try { ctx.dispose?.(); } catch { /* best-effort */ }
            ctx = null;
          }
          reranker = null;
          uiChannel.send({
            type: "boot:error",
            kind: lastFailedKind,
            message: errorMessage(err),
          });
          // One-shot mode has no /model command loop to recover through —
          // a boot error must fail loud on stderr, not park awaiting a
          // command that can never arrive.
          if (!useInk && !bridgeMode) {
            process.stderr.write(
              `Boot failed (${lastFailedKind}): ${errorMessage(err)}\n`,
            );
            process.exit(2);
          }
          const cmd = yield* awaitBootRecovery();
          if (cmd.type === "quit") {
            return "quit";
          }
          if (cmd.type === "set_model_path") {
            saveConfig({ model: { path: cmd.path } }, configPath);
            cliModelOverride = undefined;
            llmResolvedNow = resolveModelPath(cmd.path, "llm");
            modelPathNow = llmResolvedNow.path;
            modelNameNow =
              llmResolvedNow.entry?.label ?? path.basename(modelPathNow);
          } else if (cmd.type === "set_gpu") {
            // A no-fallback variant failure is the boot error /gpu exists to
            // recover from; the next attempt re-derives env from the reload.
            saveConfig({ model: { gpu: cmd.gpu } }, configPath);
            cliGpuOverride = undefined;
          } else {
            saveConfig({ model: { reranker: cmd.path } }, configPath);
            cliRerankerOverride = undefined;
            rerankerResolvedNow = resolveModelPath(cmd.path, "reranker");
            rerankModelPathNow = rerankerResolvedNow.path;
            rerankNameNow =
              rerankerResolvedNow.entry?.label ?? path.basename(rerankModelPathNow);
          }
          const reloaded = reloadLiveConfig();
          liveConfig = reloaded.config;
          liveOrigin = reloaded.origin;
        }
      }

      // Per-iteration cleanup. ensure() fires when this spawned scope ends
      // (return / throw / halt) — gives us the per-restart teardown without
      // any explicit dispose call in the handler.
      const ctxFinal = ctx;
      const rerankerFinal = reranker;
      // The reranker is an Effection resource (createReranker) and disposes
      // itself when this iteration's scope exits. ctx is not a resource, so it
      // keeps its explicit teardown.
      yield* ensure(() => {
        try { ctxFinal.dispose?.(); } catch { /* best-effort */ }
      });

      // ── Session + event forwarding ─────────────────────────────
      const runDirSink = new RunDirSink();

      const { session, events } = yield* initAgents<WorkflowEvent>(ctxFinal, {
        traceWriter,
      });

      // Replay mode: rebuild the spine from the captured checkpoint and
      // install it as the session trunk BEFORE the apps register their
      // reranker / corpus / event listeners. From this point on the rest of
      // the boot path is unchanged — runQuery forks from session.trunk like
      // any normal warm-session query, so the reconstructed KV is what the
      // research pool inherits. The branch's lifetime is tied to this
      // iteration's scope via reconstructBranch's internal `ensure()`.
      if (replayCheckpoint) {
        const replaySpine = yield* reconstructBranch(replayCheckpoint);
        session.trunk = replaySpine;
      }

      // Spawned children of this iteration's scope auto-halt on return —
      // no manual cleanup needed.
      yield* spawn(function* () {
        for (const ev of yield* each(events)) {
          runDirSink.handle(ev as WorkflowEvent);
          uiChannel.send(ev as WorkflowEvent);
          yield* each.next();
        }
      });

      // ── App registry (RFC §5.4) ────────────────────────────────
      // Apps are born already-bound to the reranker; publish it on RerankerCtx
      // so the corpus app's factory reads it. The registry owns each app's
      // detached scope and tears them down on this iteration's scope exit.
      // It also sets AppRegistryCtx, which the research pool reads to render
      // the spine and resolve per-spawn tool scope.
      yield* RerankerCtx.set(rerankerFinal);
      // Provide the wind-down signal into the run scope; the research pool reads it
      // via WindDown.get() and drains on send. Absent ⇒ no wind-down (it's optional).
      yield* WindDown.set(windDown);
      // Provide the per-agent cancel signal the same way; the pool reads it via
      // CancelAgent.get() and discards the named agent on send. Absent ⇒ no cancel.
      yield* CancelAgent.set(cancelAgent);
      const configStore = createInMemoryConfigStore();
      // Seed the config store generically from the per-app config map — no
      // app-name knowledge. Each app's factory reads its own entry on enable
      // and validates against its `configSchema`.
      for (const [name, cfg] of Object.entries(liveConfig.apps)) {
        yield* configStore.set(name, cfg);
      }
      const registry = yield* createAppRegistry({ configStore });

      // Per-boot preflight-coverage memo. Spans every command-loop iteration
      // (clarify, change_mode, re-submit), so re-planning the same query
      // reuses the recon probe instead of re-running it (TICK-004). Torn down
      // with this iteration's scope on /model or /reranker restart, which is
      // correct — those can change the enabled-app set.
      yield* CoverageCacheCtx.set(yield* createCoverageCache());

      // Enable the corpus app first so installed()[0] is corpus when present
      // (matches the old sources[0] primacy). It only enables when the user
      // has stored config for it (the factory needs a corpusPath). The factory
      // loads + tokenizes the corpus during 'loading'; a bad path surfaces a
      // toast and leaves the app disabled rather than crashing boot.
      const corpusBootCfg = liveConfig.apps[CORPUS_APP];
      if (corpusBootCfg && Object.keys(corpusBootCfg).length > 0) {
        uiChannel.send({ type: "weights:label", label: "Indexing corpus…" });
        try {
          const corpusApp = yield* registry.enable(createCorpusApp);
          const pdToc = corpusApp.source.promptData()["toc"];
          const pd = { toc: typeof pdToc === "string" ? pdToc : undefined };
          uiChannel.send({
            type: "corpus:indexed",
            corpusPath: String(corpusBootCfg.corpusPath ?? ""),
            fileCount: pd?.toc ? pd.toc.split("\n").filter(Boolean).length : 0,
            chunkCount: 0,
          });
        } catch (err) {
          uiChannel.send({
            type: "ui:error",
            message: `Corpus disabled: ${errorMessage(err)}. Use /scan to fix.`,
          });
        }
      }
      // Web is always available: createWebApp falls back to a keyless provider
      // when no tavilyKey is configured (it reads the key from the config store
      // set above, or TAVILY_API_KEY, else keyless). Enable it unconditionally.
      try {
        yield* registry.enable(createWebApp);
      } catch (err) {
        uiChannel.send({
          type: "ui:error",
          message: `Web search disabled: ${errorMessage(err)}.`,
        });
      }

      // Surface the installed AgentApps into the renderer for the Settings
      // drawer. Closes over registry + configStore + events; re-call after
      // every registry enable/disable/config change so the drawer stays in
      // sync. Display-only (best-effort catalog join), so it never blocks boot.
      function* emitApps(): Operation<void> {
        const apps = yield* buildAppDescriptors(registry, configStore);
        yield* events.send({ type: "apps:state", apps });
      }

      // Emit once boot completes (web/corpus enabled).
      yield* emitApps();

      uiChannel.send({ type: "weights:done" });
      uiChannel.send({ type: "ui:composer" });

      const harnessOpts = {
        maxTurns: MAX_TOOL_TURNS,
        findingsMaxChars,
        reasoningMode: liveConfig.defaults.reasoningMode,
        effort: liveConfig.defaults.effort,
      };

      function startRunDir(query: string, mode: "flat" | "deep"): void {
        const outputDir = liveConfig.sources.outputDir ?? process.cwd();
        runDirSink.start({ outputDir, query, mode });
      }

      // ── JSONL / --query scripted path ──────────────────────────
      // Bridge mode (Electron) drives the interactive command loop below, so
      // it skips this one-shot scripted path even though useInk is false.
      if (!useInk && !bridgeMode) {
        if (!initialQuery) {
          process.stderr.write("Non-TTY mode requires --query.\n");
          process.exit(2);
        }
        if (registry.enabled().length === 0) {
          process.stderr.write(
            "No source configured. Set TAVILY_API_KEY, pass --corpus <dir>, or store one in harness.json.\n",
          );
          process.exit(2);
        }
        const wallStartMs = performance.now();
        const result = yield* runQuery(initialQuery, session, {
          ...harnessOpts,
          wallStartMs,
          onStart: () =>
            startRunDir(initialQuery, liveConfig.defaults.reasoningMode),
        });
        if (result.type === "clarify") {
          process.stderr.write(
            "Planner asked clarifying questions; non-TTY mode can't answer. Aborting.\n",
          );
          process.exit(2);
        }
        if (result.type === "research_plan") {
          startRunDir(initialQuery, liveConfig.defaults.reasoningMode);
          yield* runResearchPlan(initialQuery, result.plan, session, {
            ...harnessOpts,
            wallStartMs,
          });
        }
        return "quit";
      }

      // ── Ink TTY command loop ───────────────────────────────────

      // Per-query run effort, set at submit_query and read by every research
      // path (clarify / edit / accept preserve it — effort is constant for a
      // query's lifetime; no mid-run switching by design). Initialised to the
      // config default for the --query boot path.
      let currentEffort: Effort = liveConfig.defaults.effort;
      let pendingPlan: {
        plan: PlanResult;
        /** The original headline query — the planner's anchor across clarify
         *  rounds. Stays constant once a query starts; clarify exchanges
         *  refine it without rewriting it. */
        query: string;
        /** True once the user has answered at least one clarify round. When
         *  set, the trunk already carries the user's latest answer as a
         *  half-turn (via `session.prefillUser` at submit_clarification);
         *  `runResearchPlan` closes the pair with `session.prefillAssistant`
         *  instead of `commitTurn`, avoiding a duplicate user-side commit. */
        clarifyExchanged: boolean;
        mode: "flat" | "deep";
        wallStartMs: number;
        /** Per-query App-participation subset captured at submit time.
         *  Threaded through `runResearchPlan` at accept_plan so research
         *  runs against the same effective-app set the planner saw. */
        appFilter: readonly string[];
      } | null = null;

      // ── Run-in-fiber (Stop escape hatch) ───────────────────────
      // The heavy operations — runQuery (preflight recon + planner) and
      // runResearchPlan (research + synth) — run in a CHILD fiber so the
      // command loop below keeps polling `each(commands)` while a run is in
      // flight. Without this the loop blocks on `yield* runResearchPlan(...)`
      // and can't even RECEIVE a `stop` command. The active run's Task is held
      // here; `stop` halts it (Effection halt tears down the run scope and
      // cancels any parked tool fetch via cancellable-fetch's scope-signal).
      // Only ONE run is active at a time (the UI gates submit/accept by phase),
      // so a single ref suffices.
      let runTask: Task<void> | null = null;

      // Spawn a run as a child fiber and hold its Task. The body OWNS its own
      // result-handling + event-sending (it can't return a value to the loop
      // without re-blocking it), so each call site passes a self-contained
      // operation. On natural completion the body clears `runTask` itself (via
      // the `clearIfCurrent` it's handed) so a finished run leaves no stale ref
      // for a later `stop` to halt. A run that throws is caught by the loop's
      // try/catch around `yield* runTask` — but we DON'T await it here; instead
      // each body wraps its own work so a failure surfaces as a `ui:error`
      // toast + return-to-composer, exactly like the old inline path's catch.
      function* startRun(
        body: (clearIfCurrent: () => void) => Operation<void>,
      ): Operation<void> {
        // A run shouldn't start while one is active; callers halt the prior run
        // first (new-query-while-running = halt-old-then-start-new). Guard
        // defensively so a double-start can't orphan the previous Task.
        if (runTask) yield* haltRun();
        const task = yield* spawn(() =>
          body(() => {
            // Clear only if WE are still the current run — a `stop`/new-run may
            // have already replaced `runTask` and halted us.
            if (runTask === task) runTask = null;
          }),
        );
        runTask = task;
      }

      // Halt the active run (if any) and clear the ref. Wrapped so a teardown
      // error can NEVER escape into the command loop and tear down the process
      // — halting must leave the app alive for the next query. `halt()` resolves
      // only after the run scope's teardown (reranker leases released, parked
      // fetches aborted) completes.
      function* haltRun(): Operation<void> {
        const task = runTask;
        runTask = null;
        if (!task) return;
        try {
          yield* task.halt();
        } catch {
          /* teardown-only error — the run is gone regardless */
        }
      }

      // Per-query App participation. Tracks which enabled apps the user
      // included in the next query. Mirrored to the UI reducer via the
      // `participation:toggled` event; the source of truth lives here
      // because main.ts is what threads `appFilter` into `runQuery` /
      // `runResearchPlan`. Default: every enabled app is included. The
      // Composer chip's Space toggle flips a name; reconfiguring an app
      // (corpus path / tavily key) auto-includes it. Web is always
      // enabled (keyless fallback) so its participation is always
      // toggleable by the user.
      const participation: Record<string, boolean> = {};
      const seedParticipation = (): void => {
        for (const app of registry.enabled()) {
          if (participation[app.manifest.name] === undefined) {
            participation[app.manifest.name] = true;
          }
        }
      };
      const currentAppFilter = (): readonly string[] =>
        registry
          .enabled()
          .filter((a) => participation[a.manifest.name] !== false)
          .map((a) => a.manifest.name);
      seedParticipation();

      // Auto-submit --query only on the first iteration. Restart iterations
      // skip this — the query already ran (or didn't) the first time.
      if (iterCaptured === 0 && initialQuery) {
        const mode = liveConfig.defaults.reasoningMode;
        const wallStartMs = performance.now();
        const submissionFilter = currentAppFilter();
        const result = yield* runQuery(initialQuery, session, {
          ...harnessOpts,
          reasoningMode: mode,
          wallStartMs,
          appFilter: submissionFilter,
          onStart: () => startRunDir(initialQuery, mode),
        });
        if (result.type === "research_plan") {
          pendingPlan = {
            plan: result.plan,
            query: initialQuery,
            clarifyExchanged: false,
            mode,
            wallStartMs,
            appFilter: submissionFilter,
          };
          yield* events.send({ type: "ui:plan_review" });
        } else if (result.type === "clarify") {
          // First-round clarify: atomic (query, formattedQs) commit bootstraps
          // the trunk via the cold path. Subsequent rounds (submit_clarification)
          // use prefillUser/prefillAssistant split-half so the user's answer
          // is visible to the planner's next fork via KV before any pairing.
          yield* call(() =>
            session.commitTurn(
              initialQuery,
              formatClarifyAsAssistantMsg(result.plan.clarifyQuestions),
            ),
          );
          pendingPlan = {
            plan: result.plan,
            query: initialQuery,
            clarifyExchanged: false,
            mode,
            wallStartMs,
            appFilter: submissionFilter,
          };
        } else {
          yield* events.send({ type: "ui:composer" });
        }
      }

      for (const cmd of yield* each(commands)) {
        try {
          if (cmd.type === "quit") return "quit";

          if (cmd.type === "stop") {
            // Escape hatch: interrupt the in-flight run and return to the
            // composer. If no run is active, no-op (the UI only shows Stop
            // while a run is in flight, but a late/duplicate stop is harmless).
            // halt() tears down the run scope — the research pool, its agent
            // fibers, and any parked tool fetch (cancellable-fetch aborts on
            // its scope-signal) — WITHOUT killing this command loop or the
            // process: the app stays warm for the next query. Streamed partials
            // (scrollback / synth.buffer / agent timelines) are preserved;
            // ui:composer only resets the phase, never the transcript.
            if (runTask) {
              yield* haltRun();
              pendingPlan = null;
              yield* events.send({ type: "ui:composer" });
            }
            continue;
          }

          if (cmd.type === "wrap_up") {
            // Graceful wind-down: signal the pool to DRAIN to a fast best-effort
            // answer — stop spawning, reap active agents, let in-flight tools
            // settle, fold. Unlike `stop`, we do NOT halt: the run scope stays
            // alive and produces its answer + synth. No-op if no run is active.
            if (runTask) windDown.send();
            continue;
          }

          if (cmd.type === "cancel_agent") {
            // Per-agent discard: signal the pool to halt that one agent's in-flight
            // tool, prune its branch (reclaim KV for its siblings), and emit a terminal
            // agent:failed(user_cancel). Unlike `wrap_up`/`stop`, the run keeps going —
            // the other agents are untouched. No-op if no run is active or the agent
            // already finished. Ephemeral (nothing persisted).
            if (runTask) cancelAgent.send({ agentId: cmd.agentId });
            continue;
          }

          if (cmd.type === "set_model_path") {
            // Composer only mounts in 'composer' phase, so no agent is in
            // flight here. Persist + signal restart; structured concurrency
            // disposes ctx/reranker as this scope unwinds, and the next
            // iteration re-boots with the new path.
            saveConfig({ model: { path: cmd.path } }, configPath);
            cliModelOverride = undefined;
            return "restart";
          }

          if (cmd.type === "set_reranker_path") {
            saveConfig({ model: { reranker: cmd.path } }, configPath);
            cliRerankerOverride = undefined;
            return "restart";
          }

          if (cmd.type === "set_gpu") {
            // Persist + restart, same shape as /model: the next iteration's
            // boot re-derives the LLOYAL_GPU env lever from the reloaded
            // config and re-creates ctx + reranker on the new backend.
            saveConfig({ model: { gpu: cmd.gpu } }, configPath);
            cliGpuOverride = undefined;
            return "restart";
          }

          if (cmd.type === "toggle_participation") {
            // Per-query App-participation toggle (chip Space). Flip the
            // local source-of-truth and mirror to the reducer so the
            // Composer chip re-renders. Defaults to true when absent.
            const current = participation[cmd.name] ?? true;
            participation[cmd.name] = !current;
            yield* events.send({
              type: "participation:toggled",
              name: cmd.name,
            });
            continue;
          }

          if (cmd.type === "set_app_config") {
            // Generic per-app config write — no app-name knowledge. Resolve
            // path-shaped string values at the boundary (~ + absolute), store
            // the WHOLE replacement in the config store, then disable+re-enable
            // the app so its factory re-reads config; the registry validates
            // against the app's `configSchema` on enable, so a bad value surfaces
            // as a toast and leaves the app disabled rather than crashing.
            const resolvedValues = resolveConfigPaths(cmd.values);
            const isClear = Object.keys(resolvedValues).length === 0;

            yield* configStore.set(cmd.name, resolvedValues);

            const factory = factoryFor(cmd.name);
            if (factory) {
              if (registry.byName(cmd.name)) yield* registry.disable(cmd.name);
              // Only re-enable when there's config OR the app runs config-less
              // (web's keyless fallback). For a cleared config on an app that
              // requires config, staying disabled is correct.
              const needsConfig = appRequiresConfig(cmd.name);
              if (!isClear || !needsConfig) {
                // A mid-session config-apply is NOT a boot — it must not drive
                // the full-screen `weights:*` loader (which flips uiPhase to
                // 'loading', blanking the timeline/drawer, with no `ui:composer`
                // to follow it back out — leaving the UI stuck on the boot
                // screen). Feedback comes from the `config:updated` success
                // toast + the `corpus:indexed` chip below; failures toast via
                // `ui:error`. The registry.enable() indexing runs inline.
                try {
                  const app = yield* registry.enable(factory);
                  // Surface an indexed-source summary when the app exposes a TOC
                  // (capability check, not a name check) so the relevant chip
                  // can show file counts.
                  const pd = (
                    app.source as { promptData?: () => { toc?: string } }
                  ).promptData?.();
                  if (pd?.toc !== undefined) {
                    uiChannel.send({
                      type: "corpus:indexed",
                      corpusPath: String(resolvedValues.corpusPath ?? ""),
                      fileCount: pd.toc
                        ? pd.toc.split("\n").filter(Boolean).length
                        : 0,
                      chunkCount: 0,
                    });
                  }
                } catch (err) {
                  // Validation/enable failed — drop the bad config and toast.
                  yield* configStore.clear(cmd.name);
                  yield* events.send({
                    type: "ui:error",
                    message: `Cannot configure ${cmd.name}: ${errorMessage(err)}`,
                  });
                  continue;
                }
              } else {
                yield* configStore.clear(cmd.name);
              }
            }

            // Configuring an app implies including it in the next query.
            participation[cmd.name] = true;

            // Persist the whole-replace under apps[name] without clobbering
            // other apps, then reload so liveConfig reflects disk.
            const saved = saveConfig(
              { apps: { [cmd.name]: resolvedValues } },
              configPath,
            );
            const reloaded = reloadLiveConfig();
            liveConfig = reloaded.config;
            liveOrigin = reloaded.origin;
            yield* events.send({
              type: "config:updated",
              config: liveConfig,
              origin: liveOrigin,
              savedTo: saved.path,
              gitignored: saved.gitignored,
              skipped: saved.skipped,
            });
            // Registry membership/config changed — refresh the Settings drawer.
            yield* emitApps();
          } else if (cmd.type === "set_output_dir") {
            // Resolve at the boundary: ~ expansion + relative→absolute happen
            // here so the persisted form in harness.json is always absolute.
            // Empty input clears the field (saveConfig drops empty values).
            const resolved = cmd.path ? resolvePath(cmd.path) : "";
            const saved = saveConfig(
              { sources: { outputDir: resolved } },
              configPath,
            );
            const reloaded = reloadLiveConfig();
            liveConfig = reloaded.config;
            liveOrigin = reloaded.origin;
            yield* events.send({
              type: "config:updated",
              config: liveConfig,
              origin: liveOrigin,
              savedTo: saved.path,
              gitignored: saved.gitignored,
              skipped: saved.skipped,
            });
          } else if (cmd.type === "set_effort") {
            // Global effort setting → persist to harness.json, reload, echo back.
            // Every subsequent query reads liveConfig.defaults.effort.
            const saved = saveConfig(
              { defaults: { ...liveConfig.defaults, effort: cmd.effort } },
              configPath,
            );
            const reloaded = reloadLiveConfig();
            liveConfig = reloaded.config;
            liveOrigin = reloaded.origin;
            yield* events.send({
              type: "config:updated",
              config: liveConfig,
              origin: liveOrigin,
              savedTo: saved.path,
              gitignored: saved.gitignored,
              skipped: saved.skipped,
            });
          } else if (cmd.type === "submit_query") {
            if (registry.enabled().length === 0) {
              yield* events.send({
                type: "ui:error",
                message: "No source configured. Add Tavily key or corpus path.",
              });
              continue;
            }
            // 0-effective-sources guard: the user has enabled apps but
            // toggled all of them off via chip Space. Block submit with
            // a toast instead of dispatching with an empty appFilter.
            if (currentAppFilter().length === 0) {
              yield* events.send({
                type: "ui:error",
                message:
                  "All sources excluded. Tab to a chip and press Space to include at least one.",
              });
              continue;
            }
            const wallStartMs = performance.now();
            // Effort is a global setting (Settings → Effort) — read the live
            // config value at submit time so a change there applies next query.
            currentEffort = liveConfig.defaults.effort;
            // A `submit_query` while a run is already in flight = the user
            // started over. Halt the old run first, then start the new (the
            // safe choice — never two concurrent research pools sharing the
            // session). Plan-edit state from the prior query is stale; drop it.
            if (runTask) {
              yield* haltRun();
              pendingPlan = null;
            }
            if (cmd.skipPlanner) {
              // START path: skip the planner entirely. The user's literal
              // query becomes a single research task. The synth gate inside
              // runResearchPlan auto-skips synth for single-task plans, so
              // the lone agent's report flows out as the answer.
              const plan = singleTaskPlan(cmd.query);
              yield* events.send({
                type: "plan:start",
                query: cmd.query,
                mode: cmd.mode,
              });
              yield* events.send({
                type: "query",
                query: cmd.query,
                warm: !!session.trunk,
              });
              yield* events.send({
                type: "plan",
                intent: plan.intent,
                tasks: plan.tasks,
                clarifyQuestions: plan.clarifyQuestions,
                tokenCount: plan.tokenCount,
                timeMs: plan.timeMs,
              });
              const submissionFilter = currentAppFilter();
              startRunDir(cmd.query, cmd.mode);
              // Run in a child fiber so `stop` can interrupt it (see startRun).
              yield* startRun(function* (clearIfCurrent) {
                try {
                  yield* runResearchPlan(cmd.query, plan, session, {
                    ...harnessOpts,
                    reasoningMode: cmd.mode,
                    effort: currentEffort,
                    wallStartMs,
                    appFilter: submissionFilter,
                    // Ask mode: let the single agent answer directly from context (0 tools OK).
                    isAsk: cmd.skipPlanner,
                  });
                  yield* events.send({ type: "ui:composer" });
                } catch (err) {
                  yield* events.send({
                    type: "ui:error",
                    message: errorMessage(err),
                  });
                } finally {
                  clearIfCurrent();
                }
              });
              continue;
            }
            const submissionFilter = currentAppFilter();
            const queryText = cmd.query;
            const queryMode = cmd.mode;
            // Run the planner (preflight recon + planner agent) in a child fiber
            // so it's interruptible too — recon can take seconds. The body owns
            // its own result-handling (sets pendingPlan / commits the clarify
            // turn / sends ui:plan_review) since it can't return to the loop
            // without re-blocking it.
            yield* startRun(function* (clearIfCurrent) {
              try {
                const result = yield* runQuery(queryText, session, {
                  ...harnessOpts,
                  reasoningMode: queryMode,
                  effort: currentEffort,
                  context: buildPlannerContext(registry.enabled()),
                  wallStartMs,
                  appFilter: submissionFilter,
                  onStart: () => startRunDir(queryText, queryMode),
                });
                if (result.type === "research_plan") {
                  pendingPlan = {
                    plan: result.plan,
                    query: queryText,
                    clarifyExchanged: false,
                    mode: queryMode,
                    wallStartMs,
                    appFilter: submissionFilter,
                  };
                  yield* events.send({ type: "ui:plan_review" });
                } else if (result.type === "clarify") {
                  // First-round clarify: atomic (query, formattedQs) commit
                  // bootstraps the trunk via the cold path. Subsequent rounds
                  // use prefillUser/prefillAssistant split-half so the user's
                  // answer is in trunk BEFORE the next planner fork.
                  yield* call(() =>
                    session.commitTurn(
                      queryText,
                      formatClarifyAsAssistantMsg(result.plan.clarifyQuestions),
                    ),
                  );
                  pendingPlan = {
                    plan: result.plan,
                    query: queryText,
                    clarifyExchanged: false,
                    mode: queryMode,
                    wallStartMs,
                    appFilter: submissionFilter,
                  };
                  // Stays in clarifying via the plan event.
                } else {
                  yield* events.send({ type: "ui:composer" });
                }
              } catch (err) {
                pendingPlan = null;
                yield* events.send({
                  type: "ui:error",
                  message: errorMessage(err),
                });
              } finally {
                clearIfCurrent();
              }
            });
          } else if (cmd.type === "submit_clarification" && pendingPlan) {
            // Q1.5: prefill the user's answer onto the trunk BEFORE running
            // the planner so the planner's fork inherits the answer via KV.
            // (Q1 alone committed the prior round's clarify Qs but the user's
            // answer was deferred to research-completion, leaving the planner
            // blind to the user's chosen interpretation.) Split-half flow:
            //
            //  1. prefillUser(cmd.answer)  — dangling user side on trunk
            //  2. runQuery → planner re-plans, sees cmd.answer in KV
            //  3. on result:
            //     - clarify  → prefillAssistant(formattedQs) closes the pair
            //     - research → leave dangling; runResearchPlan closes the
            //                   pair via prefillAssistant when research
            //                   findings arrive (gated by clarifyExchanged)
            //     - done     → passthrough handles its own commits
            const { query: origQuery, mode, wallStartMs, appFilter } = pendingPlan;
            const priorPlan = pendingPlan;
            yield* call(() => session.prefillUser(cmd.answer));
            yield* startRun(function* (clearIfCurrent) {
              try {
                const result = yield* runQuery(origQuery, session, {
                  ...harnessOpts,
                  reasoningMode: mode,
                  effort: currentEffort,
                  context: buildPlannerContext(registry.enabled()),
                  wallStartMs,
                  appFilter,
                  onStart: () => startRunDir(origQuery, mode),
                });
                if (result.type === "research_plan") {
                  pendingPlan = {
                    ...priorPlan,
                    plan: result.plan,
                    clarifyExchanged: true,
                  };
                  yield* events.send({ type: "ui:plan_review" });
                } else if (result.type === "clarify") {
                  yield* call(() =>
                    session.prefillAssistant(
                      formatClarifyAsAssistantMsg(result.plan.clarifyQuestions),
                    ),
                  );
                  pendingPlan = {
                    ...priorPlan,
                    plan: result.plan,
                    clarifyExchanged: true,
                  };
                } else {
                  pendingPlan = null;
                  yield* events.send({ type: "ui:composer" });
                }
              } catch (err) {
                pendingPlan = null;
                yield* events.send({
                  type: "ui:error",
                  message: errorMessage(err),
                });
              } finally {
                clearIfCurrent();
              }
            });
          } else if (cmd.type === "change_mode" && pendingPlan) {
            const priorPlan = pendingPlan;
            const nextMode = cmd.mode;
            yield* startRun(function* (clearIfCurrent) {
              try {
                const result = yield* runQuery(priorPlan.query, session, {
                  ...harnessOpts,
                  reasoningMode: nextMode,
                  effort: currentEffort,
                  context: buildPlannerContext(registry.enabled()),
                  wallStartMs: priorPlan.wallStartMs,
                  appFilter: priorPlan.appFilter,
                  onStart: () => startRunDir(priorPlan.query, nextMode),
                });
                if (result.type === "research_plan") {
                  pendingPlan = { ...priorPlan, plan: result.plan, mode: nextMode };
                  yield* events.send({ type: "ui:plan_review" });
                } else if (result.type === "clarify") {
                  // change_mode is a non-conversational re-plan: the user toggled
                  // mode without saying anything new. We DO NOT commit the new
                  // clarify Qs to trunk — the trunk's last assistant turn stays
                  // the prior round's Qs. The UI shows the new Qs from pendingPlan,
                  // and the user's eventual answer (via submit_clarification) will
                  // prefill onto trunk then. Documented edge: planner #N+1 forks
                  // a trunk that holds clarify_Qs_{prior} in KV while the user
                  // answered clarify_Qs_{change_mode_round}; we accept this minor
                  // KV/UI mismatch rather than forge a synthetic user turn.
                  pendingPlan = { ...priorPlan, plan: result.plan, mode: nextMode };
                } else {
                  pendingPlan = null;
                  yield* events.send({ type: "ui:composer" });
                }
              } catch (err) {
                pendingPlan = null;
                yield* events.send({
                  type: "ui:error",
                  message: errorMessage(err),
                });
              } finally {
                clearIfCurrent();
              }
            });
          } else if (cmd.type === "accept_plan" && pendingPlan) {
            if (pendingPlan.plan.intent === "clarify") {
              pendingPlan = null;
              yield* events.send({ type: "ui:composer" });
              continue;
            }
            if (registry.enabled().length === 0) {
              yield* events.send({
                type: "ui:error",
                message: "No source configured. Add Tavily key or corpus path.",
              });
              pendingPlan = null;
              continue;
            }
            startRunDir(pendingPlan.query, pendingPlan.mode);
            // Snapshot the plan; the loop clears `pendingPlan` immediately so a
            // stray plan-edit command during the run can't mutate the running
            // plan. The heavy research+synth runs in a child fiber so `stop`
            // can halt it (the primary thing Stop interrupts).
            const acceptedPlan = pendingPlan;
            pendingPlan = null;
            yield* startRun(function* (clearIfCurrent) {
              try {
                yield* runResearchPlan(
                  acceptedPlan.query,
                  acceptedPlan.plan,
                  session,
                  {
                    ...harnessOpts,
                    reasoningMode: acceptedPlan.mode,
                    effort: currentEffort,
                    wallStartMs: acceptedPlan.wallStartMs,
                    appFilter: acceptedPlan.appFilter,
                    // Q1.5: if a clarify round prefilled the user's answer onto
                    // trunk, runResearchPlan closes the dangling pair via
                    // prefillAssistant. Otherwise (no clarify), it bootstraps
                    // the pair via commitTurn(query, answer).
                    userSidePending: acceptedPlan.clarifyExchanged,
                  },
                );
                yield* events.send({ type: "ui:composer" });
              } catch (err) {
                yield* events.send({
                  type: "ui:error",
                  message: errorMessage(err),
                });
              } finally {
                clearIfCurrent();
              }
            });
          } else if (cmd.type === "cancel_plan") {
            pendingPlan = null;
            yield* events.send({ type: "ui:composer" });
          } else if (cmd.type === "edit_plan") {
            pendingPlan = null;
            yield* events.send({ type: "ui:composer", prefill: cmd.query });
          } else if (cmd.type === "update_task_description" && pendingPlan) {
            // Update the canonical plan held alongside the reducer state so
            // accept_plan reads the edited tasks. The reducer also updates
            // its copy via the plan:task_updated event below.
            pendingPlan.plan.tasks = pendingPlan.plan.tasks.map((t, i) =>
              i === cmd.index ? { ...t, description: cmd.description } : t,
            );
            yield* events.send({
              type: "plan:task_updated",
              index: cmd.index,
              description: cmd.description,
            });
          } else if (cmd.type === "add_task" && pendingPlan) {
            const insertAt = Math.max(
              0,
              Math.min(pendingPlan.plan.tasks.length, cmd.afterIndex + 1),
            );
            pendingPlan.plan.tasks = [
              ...pendingPlan.plan.tasks.slice(0, insertAt),
              { description: "" },
              ...pendingPlan.plan.tasks.slice(insertAt),
            ];
            yield* events.send({
              type: "plan:task_added",
              afterIndex: cmd.afterIndex,
            });
          } else if (cmd.type === "delete_task" && pendingPlan) {
            if (pendingPlan.plan.tasks.length > 1) {
              pendingPlan.plan.tasks = pendingPlan.plan.tasks.filter(
                (_, i) => i !== cmd.index,
              );
              yield* events.send({
                type: "plan:task_deleted",
                index: cmd.index,
              });
            }
          } else if (cmd.type === "move_task" && pendingPlan) {
            const n = pendingPlan.plan.tasks.length;
            if (
              cmd.from !== cmd.to &&
              cmd.from >= 0 &&
              cmd.from < n &&
              cmd.to >= 0 &&
              cmd.to < n
            ) {
              const tasks = [...pendingPlan.plan.tasks];
              const [moved] = tasks.splice(cmd.from, 1);
              tasks.splice(cmd.to, 0, moved);
              pendingPlan.plan.tasks = tasks;
              yield* events.send({
                type: "plan:task_moved",
                from: cmd.from,
                to: cmd.to,
              });
            }
          }
        } catch (err) {
          pendingPlan = null;
          yield* events.send({ type: "ui:error", message: errorMessage(err) });
        } finally {
          // Always advance — Effection's `each` requires a `next()` per iteration,
          // including when the body threw. Putting this in `finally` keeps the
          // command loop alive after a research/plan failure (otherwise the
          // IterationError tears the whole process down — the user sees the UI
          // error briefly, then a crash).
          yield* each.next();
        }
      }
      // commands signal closed (shouldn't normally happen) — exit cleanly.
      return "quit";
    });

    const reason = yield* task;
    if (reason === "quit") return;
    iteration++;
  }
}).catch((err: unknown) => {
  process.stderr.write(`Error: ${errorMessage(err)}\n${errorStack(err)}\n`);
  process.exit(1);
});
