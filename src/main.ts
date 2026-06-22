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
import * as os from "node:os";
import * as path from "node:path";
import { spawn as cpSpawn } from "node:child_process";
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
import {
  initAgents,
  JsonlTraceWriter,
  RerankerCtx,
  extractSpineSeed,
  reconstructBranch,
  type BranchCheckpoint,
} from "@lloyal-labs/lloyal-agents";
import type { App, TraceEvent } from "@lloyal-labs/lloyal-agents";
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
import {
  createInMemoryConfigStore,
  createAppRegistry,
} from "@lloyal-labs/rig";
import type { PlanResult, Reranker } from "@lloyal-labs/rig";
import { createReranker } from "@lloyal-labs/rig/node";
import { createWebApp } from "@lloyal-labs/web-app";
import { createCorpusApp } from "@lloyal-labs/corpus-app";
import {
  runQuery,
  runResearchPlan,
  singleTaskPlan,
  createCoverageCache,
  CoverageCacheCtx,
} from "./harness";
import {
  downloadIfMissing,
  resolveModelPath,
  type ModelCatalogEntry,
} from "./models";
import { RunDirSink } from "./run-dir";
import { resolvePath } from "./tui-ink/path-utils";
import pkg from "../package.json";

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
    "replay-trace": { type: "string" },
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

function buildEnvMeta(_config: { model?: { path?: string } } | null): import("./tui-ink/state").EnvMeta {
  const cpu = os.cpus?.()[0]?.model ?? "unknown";
  return {
    version: pkg.version,
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpu,
    nodeVersion: process.version,
    gpu: process.env.LLOYAL_GPU ?? "unknown",
  };
}

// ── Main ─────────────────────────────────────────────────────────

main(function* () {
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

  // CLI overrides for model paths get nulled when the user picks a path via
  // /model or /reranker — otherwise the CLI flag would clobber the user's
  // explicit slash choice on the next restart iteration.
  let cliModelOverride: string | undefined = cliModelPath;
  let cliRerankerOverride: string | undefined = flags.reranker;

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
    uiChannel.send({ type: "ui:env", env: buildEnvMeta(/* config */ null) });
    yield* ensure(() => { inkInstance?.unmount(); });
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
      const reloaded = loadConfig(configPath, {
        modelPath: cliModelOverride,
        reranker: cliRerankerOverride,
        corpusPath: flags.corpus,
        reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
        outputDir: cliOutputDir,
        nCtx: nCtxCli,
      });
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
          } else {
            saveConfig({ model: { reranker: cmd.path } }, configPath);
            cliRerankerOverride = undefined;
            rerankerResolvedNow = resolveModelPath(cmd.path, "reranker");
            rerankModelPathNow = rerankerResolvedNow.path;
            rerankNameNow =
              rerankerResolvedNow.entry?.label ?? path.basename(rerankModelPathNow);
          }
          const reloaded = loadConfig(configPath, {
            modelPath: cliModelOverride,
            reranker: cliRerankerOverride,
            corpusPath: flags.corpus,
            reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
            outputDir: cliOutputDir,
            nCtx: nCtxCli,
          });
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
      const configStore = createInMemoryConfigStore();
      if (liveConfig.sources.tavilyKey) {
        yield* configStore.set("web", { tavilyKey: liveConfig.sources.tavilyKey });
      }
      if (liveConfig.sources.corpusPath) {
        yield* configStore.set("corpus", {
          corpusPath: liveConfig.sources.corpusPath,
        });
      }
      const registry = yield* createAppRegistry({ configStore });

      // Per-boot preflight-coverage memo. Spans every command-loop iteration
      // (clarify, change_mode, re-submit), so re-planning the same query
      // reuses the recon probe instead of re-running it (TICK-004). Torn down
      // with this iteration's scope on /model or /reranker restart, which is
      // correct — those can change the enabled-app set.
      yield* CoverageCacheCtx.set(yield* createCoverageCache());

      // Enable the corpus app first so installed()[0] is corpus when present
      // (matches the old sources[0] primacy). The factory loads + tokenizes
      // the corpus during 'loading'; a bad path surfaces a toast and leaves
      // the app disabled rather than crashing boot.
      if (liveConfig.sources.corpusPath) {
        uiChannel.send({ type: "weights:label", label: "Indexing corpus…" });
        try {
          const corpusApp = yield* registry.enable(createCorpusApp);
          const pdToc = corpusApp.source.promptData()["toc"];
          const pd = { toc: typeof pdToc === "string" ? pdToc : undefined };
          uiChannel.send({
            type: "corpus:indexed",
            corpusPath: liveConfig.sources.corpusPath,
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

      uiChannel.send({ type: "weights:done" });
      uiChannel.send({ type: "ui:composer" });

      const harnessOpts = {
        maxTurns: MAX_TOOL_TURNS,
        findingsMaxChars,
        reasoningMode: liveConfig.defaults.reasoningMode,
      };

      function startRunDir(query: string, mode: "flat" | "deep"): void {
        const outputDir = liveConfig.sources.outputDir ?? process.cwd();
        runDirSink.start({ outputDir, query, mode });
      }

      // ── JSONL / --query scripted path ──────────────────────────
      if (!useInk) {
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

          if (cmd.type === "set_tavily_key") {
            const saved = saveConfig(
              { sources: { tavilyKey: cmd.key } },
              configPath,
            );
            const reloaded = loadConfig(configPath, {
              modelPath: cliModelOverride,
              reranker: cliRerankerOverride,
              corpusPath: flags.corpus,
              reasoningMode: reasoningModeFlag as "flat" | "deep" | undefined,
              outputDir: cliOutputDir,
            });
            liveConfig = reloaded.config;
            liveOrigin = reloaded.origin;
            // Swap the web provider in place: the factory reads the key from
            // the config store at construction (Tavily with a key, keyless
            // without). Web stays enabled either way.
            if (registry.byName("web")) yield* registry.disable("web");
            if (liveConfig.sources.tavilyKey) {
              yield* configStore.set("web", {
                tavilyKey: liveConfig.sources.tavilyKey,
              });
            } else {
              yield* configStore.clear("web");
            }
            try {
              yield* registry.enable(createWebApp);
              // Reconfigure = strong signal of intent; auto-include.
              participation["web"] = true;
            } catch (err) {
              yield* events.send({
                type: "ui:error",
                message: `Web search disabled: ${errorMessage(err)}.`,
              });
            }
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
              modelPath: cliModelOverride,
              reranker: cliRerankerOverride,
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
            // Re-enable the corpus app against the new path. Validate BEFORE
            // persisting: a bad path that lands in harness.json would disable
            // corpus on every subsequent boot. Empty path clears + disables.
            if (registry.byName("corpus")) yield* registry.disable("corpus");
            if (resolved) {
              uiChannel.send({
                type: "weights:start",
                label: "Indexing corpus…",
              });
              yield* configStore.set("corpus", { corpusPath: resolved });
              try {
                const corpusApp = yield* registry.enable(createCorpusApp);
                // Reconfigure = strong signal of intent; auto-include.
                participation["corpus"] = true;
                const pd = (
                  corpusApp.source as { promptData?: () => { toc?: string } }
                ).promptData?.();
                uiChannel.send({
                  type: "corpus:indexed",
                  corpusPath: resolved,
                  fileCount: pd?.toc
                    ? pd.toc.split("\n").filter(Boolean).length
                    : 0,
                  chunkCount: 0,
                });
                uiChannel.send({ type: "weights:done" });
              } catch (err) {
                uiChannel.send({ type: "weights:done" });
                yield* configStore.clear("corpus");
                yield* events.send({
                  type: "ui:error",
                  message: `Cannot use ${resolved}: ${errorMessage(err)}`,
                });
                continue;
              }
            } else {
              yield* configStore.clear("corpus");
            }
            // Path validated (or cleared) — persist + reload.
            const saved = saveConfig(
              { sources: { corpusPath: resolved } },
              configPath,
            );
            const reloaded = loadConfig(configPath, {
              modelPath: cliModelOverride,
              reranker: cliRerankerOverride,
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
          } else if (cmd.type === "open_feedback") {
            try {
              const url = cmd.url;
              let child;
              if (process.platform === "darwin") {
                child = cpSpawn("open", [url], { stdio: "ignore", detached: true });
              } else if (process.platform === "win32") {
                // Not `cmd /c start "" <url>`: cmd.exe re-parses the URL and an
                // unquoted `&` (every issue URL has them between query params) is
                // read as a command separator. PowerShell Start-Process with a
                // single-quoted URL keeps `&` literal. The URL is percent-encoded
                // so it can never contain a literal single quote.
                child = cpSpawn(
                  "powershell.exe",
                  ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`],
                  { stdio: "ignore", detached: true },
                );
              } else {
                child = cpSpawn("xdg-open", [url], { stdio: "ignore", detached: true });
              }
              child.on("error", () => { /* best-effort; panel shows the URL */ });
              child.unref();
            } catch {
              // Swallow — the FeedbackPanel keeps the URL on screen for manual copy.
            }
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
              yield* runResearchPlan(cmd.query, plan, session, {
                ...harnessOpts,
                reasoningMode: cmd.mode,
                wallStartMs,
                appFilter: submissionFilter,
              });
              yield* events.send({ type: "ui:composer" });
              continue;
            }
            const submissionFilter = currentAppFilter();
            const result = yield* runQuery(cmd.query, session, {
              ...harnessOpts,
              reasoningMode: cmd.mode,
              context: buildPlannerContext(registry.enabled()),
              wallStartMs,
              appFilter: submissionFilter,
              onStart: () => startRunDir(cmd.query, cmd.mode),
            });
            if (result.type === "research_plan") {
              pendingPlan = {
                plan: result.plan,
                query: cmd.query,
                clarifyExchanged: false,
                mode: cmd.mode,
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
                  cmd.query,
                  formatClarifyAsAssistantMsg(result.plan.clarifyQuestions),
                ),
              );
              pendingPlan = {
                plan: result.plan,
                query: cmd.query,
                clarifyExchanged: false,
                mode: cmd.mode,
                wallStartMs,
                appFilter: submissionFilter,
              };
              // Stays in clarifying via the plan event.
            } else {
              yield* events.send({ type: "ui:composer" });
            }
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
            yield* call(() => session.prefillUser(cmd.answer));
            const result = yield* runQuery(origQuery, session, {
              ...harnessOpts,
              reasoningMode: mode,
              context: buildPlannerContext(registry.enabled()),
              wallStartMs,
              appFilter,
              onStart: () => startRunDir(origQuery, mode),
            });
            if (result.type === "research_plan") {
              pendingPlan = {
                ...pendingPlan,
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
                ...pendingPlan,
                plan: result.plan,
                clarifyExchanged: true,
              };
            } else {
              pendingPlan = null;
              yield* events.send({ type: "ui:composer" });
            }
          } else if (cmd.type === "change_mode" && pendingPlan) {
            const result = yield* runQuery(pendingPlan.query, session, {
              ...harnessOpts,
              reasoningMode: cmd.mode,
              context: buildPlannerContext(registry.enabled()),
              wallStartMs: pendingPlan.wallStartMs,
              appFilter: pendingPlan.appFilter,
              onStart: () => startRunDir(pendingPlan!.query, cmd.mode),
            });
            if (result.type === "research_plan") {
              pendingPlan = { ...pendingPlan, plan: result.plan, mode: cmd.mode };
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
              pendingPlan = { ...pendingPlan, plan: result.plan, mode: cmd.mode };
            } else {
              pendingPlan = null;
              yield* events.send({ type: "ui:composer" });
            }
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
            yield* runResearchPlan(
              pendingPlan.query,
              pendingPlan.plan,
              session,
              {
                ...harnessOpts,
                reasoningMode: pendingPlan.mode,
                wallStartMs: pendingPlan.wallStartMs,
                appFilter: pendingPlan.appFilter,
                // Q1.5: if a clarify round prefilled the user's answer onto
                // trunk, runResearchPlan closes the dangling pair via
                // prefillAssistant. Otherwise (no clarify), it bootstraps the
                // pair via commitTurn(query, answer).
                userSidePending: pendingPlan.clarifyExchanged,
              },
            );
            pendingPlan = null;
            yield* events.send({ type: "ui:composer" });
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
