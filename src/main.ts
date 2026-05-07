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
 * JSONL / non-TTY mode: bypasses Ink entirely; `handleQuery` composes
 * runPlanner + runResearchBranch and emits the usual event stream.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  main,
  ensure,
  createSignal,
  spawn,
  each,
  call,
} from "effection";
import type { Operation } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { initAgents, JsonlTraceWriter } from "@lloyal-labs/lloyal-agents";
import type { Source } from "@lloyal-labs/lloyal-agents";
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
import { loadConfig, saveConfig } from "./tui-ink/config";
import { createBus, type EventBus } from "./tui-ink/event-bus";
import { TavilyProvider } from "@lloyal-labs/rig";
import type {
  PlanResult,
  SourceContext,
  Chunk,
  Reranker,
} from "@lloyal-labs/rig";
import {
  createReranker,
  WebSource,
  CorpusSource,
  chunkResources,
  resolveCorpusInput,
} from "@lloyal-labs/rig/node";
import type { Resource } from "@lloyal-labs/rig/node";
import ignoreFactory from "ignore";
import {
  handleQuery,
  runPlanner,
  runPassthroughBranch,
  runResearchBranch,
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
    reranker: { type: "string" },
    corpus: { type: "string" },
    config: { type: "string" },
    "findings-budget": { type: "string" },
    "reasoning-mode": { type: "string" },
    "n-ctx": { type: "string" },
    "output-dir": { type: "string" },
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

const cliModelPath = positionals[0] || undefined;
const jsonlMode = flags.jsonl;
const verbose = flags.verbose;
const cliOutputDir = flags["output-dir"];
const initialQuery = flags.query;
const configPath = flags.config ?? DEFAULT_CONFIG_PATH;

const nCtxFlag = flags["n-ctx"];
if (nCtxFlag !== undefined && !/^\d+$/.test(nCtxFlag)) {
  process.stderr.write(
    `Invalid --n-ctx: ${nCtxFlag}. Expected a positive integer.\n`,
  );
  process.exit(1);
}
const nCtxCli = nCtxFlag !== undefined ? parseInt(nCtxFlag, 10) : undefined;

// Merge: CLI flag > env > harness.json > default.
const loaded = loadConfig(configPath, {
  modelPath: cliModelPath,
  reranker: flags.reranker,
  corpusPath: flags.corpus,
  reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
  nCtx: nCtxCli,
  outputDir: cliOutputDir,
});
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

// ── Corpus cache — load resources once per unique corpusPath ─────

const corpusCache = new Map<
  string,
  { resources: Resource[]; chunks: Chunk[] }
>();

/** Effection-aware corpus indexer.
 *
 *  Walks the user's input (directory or glob pattern), reads each `.md`/
 *  `.mdx` file, and builds chunks. Emits `weights:label` events with the
 *  current filename + (i/N) progress per file. Yields to the event loop
 *  via setImmediate between files so Ink can re-render the inline-
 *  updating status line.
 *
 *  Input semantics (delegated to rig's `resolveCorpusInput`):
 *    - `/path/to/dir` → recursive `**\/*.{md,mdx}`, filtered by .gitignore
 *    - `/path/to/dir/*.md` → top-level only (user-supplied pattern)
 *    - `/path/to/dir/**\/*.md` → recursive (user-supplied pattern)
 *    - Other extensions → rig throws
 *
 *  Honors `.gitignore` at the cwd root if present. Cached by input string
 *  so subsequent calls return cached entries without re-walking.
 *
 *  Without the per-file yields the entire walk runs in one synchronous
 *  burst, all the label events queue but Ink only renders the LAST one
 *  — defeating the "show me what's happening" purpose. */
function* indexCorpus(
  corpusInput: string,
  channel: EventBus<WorkflowEvent>,
): Operation<{
  resources: Resource[];
  chunks: Chunk[];
}> {
  const existing = corpusCache.get(corpusInput);
  if (existing) return existing;

  const { cwd, pattern } = resolveCorpusInput(corpusInput);
  // Plain directory → recursive walk (filtered by .gitignore below).
  // Glob pattern → use as-is.
  const effectivePattern = pattern ?? "**/*.{md,mdx}";

  // Honor .gitignore at the cwd root — same semantics as rig's
  // loadResources. The user's existing .gitignore is the right place
  // to declare what should never be in scope.
  const gitignorePath = path.join(cwd, ".gitignore");
  const ig = fs.existsSync(gitignorePath)
    ? ignoreFactory().add(fs.readFileSync(gitignorePath, "utf8"))
    : null;

  const all = fs.globSync(effectivePattern, { cwd }) as string[];
  const files = (ig ? all.filter((f) => !ig.ignores(f)) : all).sort();

  if (files.length === 0) {
    // Throw rather than process.exit — callers (boot eager-index + the
    // /scan command handler) catch this and surface a recoverable toast
    // so the user can fix the path without restarting. Writing to stderr
    // mid-Ink-render also corrupts the terminal; throwing keeps output
    // clean.
    throw new Error(
      `No .md(x) files at ${cwd}${pattern ? ` matching ${pattern}` : ''}`,
    );
  }

  channel.send({
    type: 'weights:label',
    label: `Indexing corpus (${files.length} files)…`,
  });

  // Read + collect resources, yielding between files so Ink renders the
  // updating label.
  const resources: Resource[] = [];
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    channel.send({
      type: 'weights:label',
      label: `Indexing: ${rel} (${i + 1}/${files.length})`,
    });
    yield* call(
      () =>
        new Promise<void>((resolve) => {
          // setImmediate yields to the event loop → Ink re-renders the
          // label that the previous send queued. Tiny pause per file but
          // gives the user visible per-file progress.
          setImmediate(() => {
            try {
              resources.push({
                name: rel,
                content: fs.readFileSync(path.join(cwd, rel), 'utf8'),
              });
            } catch {
              /* skip unreadable file */
            }
            resolve();
          });
        }),
    );
  }

  // Chunk (parseMarkdown WASM call per file). Same yielding pattern.
  channel.send({ type: 'weights:label', label: 'Chunking corpus…' });
  yield* call(
    () => new Promise<void>((resolve) => setImmediate(resolve)),
  );
  const chunks = chunkResources(resources);

  const entry = { resources, chunks };
  corpusCache.set(corpusInput, entry);
  return entry;
}

/** Build a fresh Source[] from the current config. Synchronous —
 *  assumes the corpus is already indexed (call ensureCorpusIndexed
 *  before submit-query paths). WebSource wraps the Tavily client. */
function buildSources(config: Config): Source<SourceContext, Chunk>[] {
  const sources: Source<SourceContext, Chunk>[] = [];
  if (config.sources.corpusPath) {
    const cached = corpusCache.get(config.sources.corpusPath);
    if (cached) {
      sources.push(
        new CorpusSource(cached.resources, cached.chunks, {
          grep: { maxResults: 50, lineMaxChars: 200 },
          readFile: { defaultMaxLines: 100 },
        }),
      );
    }
  }
  if (config.sources.tavilyKey) {
    // TavilyProvider takes the key as a positional string argument.
    sources.push(
      new WebSource(new TavilyProvider(config.sources.tavilyKey), {
        topN: 5,
        fetch: { maxChars: 3000, topK: 5, timeout: 10_000, tokenBudget: 1200 },
      }),
    );
  }
  return sources;
}

/** Summarize attached sources for the planner prompt. Includes the corpus
 *  table-of-contents (same pattern as corpus-worker.eta's `it.toc`) so the
 *  planner can decide research vs. clarify vs. passthrough with full
 *  awareness of what's actually available. */
function buildPlannerContext(sources: Source<SourceContext, Chunk>[]): string {
  if (sources.length === 0) return "";
  const lines: string[] = ["Available research sources:"];
  let hasWeb = false;
  for (const s of sources) {
    // `promptData` isn't declared on Source — it's specific to CorpusSource.
    // Duck-type check so the planner prompt gets the corpus TOC. Call as
    // `corpus.promptData()` (not via a detached `pd()` reference) so `this`
    // binds to the source instance — `_buildToc` is a private method on
    // CorpusSource and needs `this` to read `_chunks`.
    const corpus = s as unknown as { promptData?: () => { toc?: string } };
    if (typeof corpus.promptData === "function") {
      const data = corpus.promptData();
      lines.push("", "## Local corpus");
      lines.push(
        "Files and top-level topics (full-text searchable via grep/read/search tools):",
      );
      if (data.toc) lines.push(data.toc);
    } else if (s.name === "web") {
      hasWeb = true;
    }
  }
  if (hasWeb) {
    lines.push("", "## Web search");
    lines.push(
      "web search is available for live web queries (web_search + fetch_page tools).",
    );
  }
  return lines.join("\n");
}

// ── Error helpers ────────────────────────────────────────────────

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const errorStack = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
  const modelName = path.basename(modelPath).replace(/-Q\w+\.gguf$/, "");
  const rerankName = path
    .basename(rerankModelPath)
    .replace(/-q\w+\.gguf$/i, "");

  const useInk = isTTY && !jsonlMode;

  // Pre-boot logs only in non-Ink mode — Ink mounts ASAP in TTY mode and
  // handles download/loading UI itself.
  if (!useInk) {
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
  } else {
    // Non-TTY / JSONL: drain the bus to JSONL stdout. Synchronous subscribe
    // replays any already-buffered events immediately.
    uiChannel.subscribe((ev) => {
      emit((ev as { type: string }).type, ev as unknown as Record<string, unknown>);
    });
  }

  // ── Downloads + weights load (with /model recovery loop) ──────
  // Retryable: any failure (HF 404, network, invalid local file, etc.)
  // emits boot:error → BootStatus renders the error in Ink (NOT stderr)
  // → user types /model <path> or /quit → loop retries with the new path
  // or exits cleanly. Avoids the stderr-during-render crash UX.

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

  /** Inspect the resolved set, emit `download:plan` for any entries that
   *  will need fetching. Sent once before the ensureFile loop so the UI
   *  can render a stable two-line tree from the moment any download
   *  begins (instead of growing mid-stream when reranker starts). */
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

  /** Drain `commands` until we see one of the recovery commands. Other
   *  commands during boot recovery are ignored — the user has only three
   *  meaningful actions at this point. */
  function* awaitBootRecovery(): Operation<
    | { type: "set_model_path"; path: string }
    | { type: "set_reranker_path"; path: string }
    | { type: "quit" }
  > {
    for (const cmd of yield* each(commands)) {
      if (
        cmd.type === "quit" ||
        cmd.type === "set_model_path" ||
        cmd.type === "set_reranker_path"
      ) {
        yield* each.next();
        return cmd;
      }
      yield* each.next();
    }
    return { type: "quit" };
  }

  let llmResolvedNow = llmResolved;
  let modelPathNow = modelPath;
  let modelNameNow = modelName;
  let rerankerResolvedNow = rerankerResolved;
  let rerankModelPathNow = rerankModelPath;
  let rerankNameNow = rerankName;

  let ctx: SessionContext | null = null;
  let reranker: Reranker | null = null;

  // First iteration uses the bootstrapped plan (no bus emit needed).
  // Subsequent iterations (after /model or /reranker recovery) re-plan via
  // the bus since paths may have changed.
  let firstBootIteration = true;

  while (ctx === null || reranker === null) {
    // `lastFailedKind` is set BEFORE each step so the catch can attribute
    // the failure to the right component without unwinding through an
    // intermediate try/catch per step.
    let lastFailedKind: "llm" | "reranker" = "llm";
    try {
      if (!firstBootIteration) {
        planDownloads([llmResolvedNow, rerankerResolvedNow]);
      }
      firstBootIteration = false;

      lastFailedKind = "llm";
      yield* ensureFile(llmResolvedNow);

      lastFailedKind = "reranker";
      yield* ensureFile(rerankerResolvedNow);

      lastFailedKind = "llm";
      uiChannel.send({ type: "weights:start", label: `Loading ${modelNameNow}…` });
      ctx = yield* call(() =>
        createContext({
          modelPath: modelPathNow,
          nCtx,
          nSeqMax: 64,
          typeK: "q4_0",
          typeV: "q4_0",
        }),
      );

      lastFailedKind = "reranker";
      uiChannel.send({ type: "weights:label", label: `Loading ${rerankNameNow}…` });
      reranker = yield* call(() =>
        createReranker(rerankModelPathNow, { nSeqMax: 8, nCtx: 16384 }),
      );
    } catch (err) {
      // Tear down anything that loaded. createContext succeeding then
      // createReranker failing leaves ctx alive — must dispose so the
      // retry doesn't double-load.
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
      const cmd = yield* awaitBootRecovery();
      if (cmd.type === "quit") {
        inkInstance?.unmount();
        process.exit(0);
      }
      if (cmd.type === "set_model_path") {
        saveConfig({ model: { path: cmd.path } }, configPath);
        llmResolvedNow = resolveModelPath(cmd.path, "llm");
        modelPathNow = llmResolvedNow.path;
        modelNameNow =
          llmResolvedNow.entry?.label ?? path.basename(modelPathNow);
      } else {
        // set_reranker_path
        saveConfig({ model: { reranker: cmd.path } }, configPath);
        rerankerResolvedNow = resolveModelPath(cmd.path, "reranker");
        rerankModelPathNow = rerankerResolvedNow.path;
        rerankNameNow =
          rerankerResolvedNow.entry?.label ?? path.basename(rerankModelPathNow);
      }
      const reloaded = loadConfig(configPath, {
        modelPath: cmd.type === "set_model_path" ? cmd.path : cliModelPath,
        reranker:
          cmd.type === "set_reranker_path" ? cmd.path : flags.reranker,
        corpusPath: flags.corpus,
        reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
        outputDir: cliOutputDir,
        nCtx: nCtxCli,
      });
      liveConfig = reloaded.config;
      liveOrigin = reloaded.origin;
    }
  }
  yield* ensure(() => {
    reranker!.dispose();
  });
  uiChannel.send({ type: "weights:done" });

  // ── Session + event forwarding ─────────────────────────────
  // Session-scoped trace: one trace.jsonl per process invocation, captures
  // every query (including warm follow-ups) in one file. Always-on; the
  // file is created upfront under the user's output-dir.
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

  const runDirSink = new RunDirSink();

  const { session, events } = yield* initAgents<WorkflowEvent>(ctx, {
    traceWriter,
  });

  // Forward all runtime events: per-query artifact sink first, then UI.
  yield* spawn(function* () {
    for (const ev of yield* each(events)) {
      runDirSink.handle(ev as WorkflowEvent);
      uiChannel.send(ev as WorkflowEvent);
      yield* each.next();
    }
  });

  // Eager corpus indexing — runs during the 'loading' phase so the user
  // sees per-file progress in the boot status line. Avoids a silent
  // 30-second-to-minutes pause on the first query when the corpus has
  // hundreds of files (recursive **/*.{md,mdx} walk).
  //
  // Tolerate failure: a stale harness.json with a no-longer-valid
  // corpusPath (dir deleted, drive unmounted, etc.) must NOT crash boot.
  // Surface as a toast and continue — user can /scan a new path or clear
  // via empty value. Boot completes either way.
  if (liveConfig.sources.corpusPath) {
    try {
      const indexed = yield* indexCorpus(
        liveConfig.sources.corpusPath,
        uiChannel,
      );
      uiChannel.send({
        type: "corpus:indexed",
        corpusPath: liveConfig.sources.corpusPath,
        fileCount: indexed.resources.length,
        chunkCount: indexed.chunks.length,
      });
    } catch (err) {
      uiChannel.send({
        type: "ui:error",
        message: `Corpus disabled: ${(err as Error).message}. Use /scan to fix.`,
      });
    }
  }

  // Transition reducer out of 'loading' into 'composer'. (config:loaded was
  // already in the bootstrap; this nudges uiPhase now that boot is complete.)
  uiChannel.send({ type: "ui:composer" });

  const harnessOpts = {
    maxTurns: MAX_TOOL_TURNS,
    findingsMaxChars,
    reasoningMode: liveConfig.defaults.reasoningMode,
  };

  // Helper: start a per-query run-dir before any operation that produces
  // artifacts (research or passthrough). Reads liveConfig at call time so
  // composer-driven output-dir changes take effect on the next query.
  function startRunDir(query: string, mode: "flat" | "deep"): void {
    const outputDir = liveConfig.sources.outputDir ?? process.cwd();
    runDirSink.start({ outputDir, query, mode });
  }

  // ── JSONL / --query scripted path ──────────────────────────
  // When Ink isn't mounted, fall back to the existing handleQuery
  // composer. `--query` without a TTY runs exactly one query then exits;
  // otherwise there's nowhere for follow-ups to come from.
  if (!useInk) {
    if (!initialQuery) {
      process.stderr.write("Non-TTY mode requires --query.\n");
      process.exit(2);
    }
    const sources = buildSources(liveConfig);
    if (sources.length === 0) {
      process.stderr.write(
        "No source configured. Set TAVILY_API_KEY, pass --corpus <dir>, or store one in harness.json.\n",
      );
      process.exit(2);
    }
    startRunDir(initialQuery, liveConfig.defaults.reasoningMode);
    yield* handleQuery(initialQuery, session, sources, reranker, harnessOpts);
    return;
  }

  // ── Ink TTY command loop ───────────────────────────────────
  // (config is already seeded via the render() bootstrap arg above.)

  let pendingPlan: {
    plan: PlanResult;
    query: string;
    mode: "flat" | "deep";
    wallStartMs: number;
  } | null = null;

  // Auto-submit if --query was passed. Handled inline (not via commands)
  // because the commands Signal isn't yet being drained, and Signals don't
  // buffer — a send before `each(commands)` starts would be lost.
  if (initialQuery) {
    const mode = liveConfig.defaults.reasoningMode;
    const wallStartMs = performance.now();
    yield* events.send({ type: "plan:start", query: initialQuery, mode });
    const plan = yield* runPlanner(initialQuery, session, {
      reasoningMode: mode,
    });
    if (plan.intent === "passthrough") {
      startRunDir(initialQuery, mode);
      yield* runPassthroughBranch(initialQuery, session, plan, wallStartMs);
      yield* events.send({ type: "ui:composer" });
    } else {
      pendingPlan = { plan, query: initialQuery, mode, wallStartMs };
      yield* events.send({ type: "ui:plan_review" });
    }
  }

  for (const cmd of yield* each(commands)) {
    try {
      if (cmd.type === "quit") break;

      if (cmd.type === "set_tavily_key") {
        liveConfig = {
          ...liveConfig,
          sources: { ...liveConfig.sources, tavilyKey: cmd.key },
        };
        const saved = saveConfig(
          { sources: { tavilyKey: cmd.key } },
          configPath,
        );
        const reloaded = loadConfig(configPath, {
          modelPath: cliModelPath,
          reranker: flags.reranker,
          corpusPath: flags.corpus,
          reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
          outputDir: cliOutputDir,
        });
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
      } else if (cmd.type === "set_output_dir") {
        // Resolve at the boundary: ~ expansion + relative→absolute happen
        // here so the persisted form in harness.json is always absolute.
        // Empty input clears the field (saveConfig drops empty values).
        const resolved = cmd.path ? resolvePath(cmd.path) : "";
        const saved = saveConfig(
          { sources: { outputDir: resolved } },
          configPath,
        );
        const reloaded = loadConfig(configPath, {
          modelPath: cliModelPath,
          reranker: flags.reranker,
          corpusPath: flags.corpus,
          reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
          outputDir: cliOutputDir,
        });
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
      } else if (cmd.type === "set_corpus_path") {
        const resolved = cmd.path ? resolvePath(cmd.path) : "";
        // Validate BEFORE persisting. A bad path that lands in
        // harness.json bricks every subsequent boot until the user
        // hand-edits the file. Empty path always succeeds (it clears).
        if (resolved) {
          uiChannel.send({
            type: "weights:start",
            label: "Indexing corpus…",
          });
          let indexed: { resources: unknown[]; chunks: unknown[] };
          try {
            indexed = yield* indexCorpus(resolved, uiChannel);
          } catch (err) {
            uiChannel.send({ type: "weights:done" });
            yield* events.send({
              type: "ui:error",
              message: `Cannot use ${resolved}: ${(err as Error).message}`,
            });
            continue;
          }
          uiChannel.send({
            type: "corpus:indexed",
            corpusPath: resolved,
            fileCount: indexed.resources.length,
            chunkCount: indexed.chunks.length,
          });
          uiChannel.send({ type: "weights:done" });
        }
        // Path validated (or empty) — persist + reload.
        const saved = saveConfig(
          { sources: { corpusPath: resolved } },
          configPath,
        );
        const reloaded = loadConfig(configPath, {
          modelPath: cliModelPath,
          reranker: flags.reranker,
          corpusPath: flags.corpus,
          reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
          outputDir: cliOutputDir,
        });
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
        if (resolved) yield* events.send({ type: "ui:composer" });
      } else if (cmd.type === "submit_query") {
        const wallStartMs = performance.now();
        const sources = buildSources(liveConfig);
        if (sources.length === 0) {
          yield* events.send({
            type: "ui:error",
            message: "No source configured. Add Tavily key or corpus path.",
          });
          continue;
        }
        const plannerContext = buildPlannerContext(sources);
        yield* events.send({
          type: "plan:start",
          query: cmd.query,
          mode: cmd.mode,
        });
        const plan = yield* runPlanner(cmd.query, session, {
          reasoningMode: cmd.mode,
          context: plannerContext,
        });
        if (plan.intent === "passthrough") {
          startRunDir(cmd.query, cmd.mode);
          yield* runPassthroughBranch(cmd.query, session, plan, wallStartMs);
          yield* events.send({ type: "ui:composer" });
        } else if (plan.intent === "clarify") {
          // Reducer routes to uiPhase='clarifying' via the plan event —
          // questions stay on screen while the composer takes the answer.
          pendingPlan = { plan, query: cmd.query, mode: cmd.mode, wallStartMs };
        } else {
          pendingPlan = { plan, query: cmd.query, mode: cmd.mode, wallStartMs };
          yield* events.send({ type: "ui:plan_review" });
        }
      } else if (cmd.type === "submit_clarification" && pendingPlan) {
        // Re-run the planner with the original query + the prior questions
        // and the user's answer folded into the context. Sources unchanged.
        const {
          query: origQuery,
          plan: priorPlan,
          mode,
          wallStartMs,
        } = pendingPlan;
        const sources = buildSources(liveConfig);
        const qa = [
          "Prior clarification exchange:",
          ...priorPlan.clarifyQuestions.map((q, i) => `(${i + 1}) ${q}`),
          "",
          `User response: ${cmd.answer}`,
          "",
          "Use this exchange to proceed with research if possible.",
        ].join("\n");
        const plannerContext = [buildPlannerContext(sources), qa]
          .filter(Boolean)
          .join("\n\n");
        yield* events.send({ type: "plan:start", query: origQuery, mode });
        const plan = yield* runPlanner(origQuery, session, {
          reasoningMode: mode,
          context: plannerContext,
        });
        if (plan.intent === "passthrough") {
          startRunDir(origQuery, mode);
          yield* runPassthroughBranch(origQuery, session, plan, wallStartMs);
          pendingPlan = null;
          yield* events.send({ type: "ui:composer" });
        } else if (plan.intent === "clarify") {
          pendingPlan = { plan, query: origQuery, mode, wallStartMs };
          // stays in clarifying via the plan event
        } else {
          pendingPlan = { plan, query: origQuery, mode, wallStartMs };
          yield* events.send({ type: "ui:plan_review" });
        }
      } else if (cmd.type === "change_mode" && pendingPlan) {
        const sources = buildSources(liveConfig);
        const plannerContext = buildPlannerContext(sources);
        yield* events.send({
          type: "plan:start",
          query: pendingPlan.query,
          mode: cmd.mode,
        });
        const plan = yield* runPlanner(pendingPlan.query, session, {
          reasoningMode: cmd.mode,
          context: plannerContext,
        });
        if (plan.intent === "passthrough") {
          startRunDir(pendingPlan.query, cmd.mode);
          yield* runPassthroughBranch(
            pendingPlan.query,
            session,
            plan,
            pendingPlan.wallStartMs,
          );
          pendingPlan = null;
          yield* events.send({ type: "ui:composer" });
        } else if (plan.intent === "clarify") {
          pendingPlan = { ...pendingPlan, plan, mode: cmd.mode };
          // stays in clarifying via the plan event
        } else {
          pendingPlan = { ...pendingPlan, plan, mode: cmd.mode };
          yield* events.send({ type: "ui:plan_review" });
        }
      } else if (cmd.type === "accept_plan" && pendingPlan) {
        if (pendingPlan.plan.intent === "clarify") {
          pendingPlan = null;
          yield* events.send({ type: "ui:composer" });
          continue;
        }
        const sources = buildSources(liveConfig);
        if (sources.length === 0) {
          yield* events.send({
            type: "ui:error",
            message: "No source configured. Add Tavily key or corpus path.",
          });
          pendingPlan = null;
          continue;
        }
        startRunDir(pendingPlan.query, pendingPlan.mode);
        yield* runResearchBranch(
          pendingPlan.query,
          pendingPlan.plan,
          session,
          sources,
          reranker,
          {
            ...harnessOpts,
            reasoningMode: pendingPlan.mode,
          },
          pendingPlan.wallStartMs,
        );
        pendingPlan = null;
        yield* events.send({ type: "ui:composer" });
      } else if (cmd.type === "cancel_plan") {
        pendingPlan = null;
        yield* events.send({ type: "ui:composer" });
      } else if (cmd.type === "edit_plan") {
        pendingPlan = null;
        yield* events.send({ type: "ui:composer", prefill: cmd.query });
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
}).catch((err: unknown) => {
  process.stderr.write(`Error: ${errorMessage(err)}\n${errorStack(err)}\n`);
  process.exit(1);
});
