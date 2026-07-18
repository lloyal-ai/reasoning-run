/**
 * __served-smoke — the served (`./runner`) export's model-free contract.
 *
 * Proves the per-session `Runner` shape + in-memory `saveConfig` + no-op
 * `reloadRuntime` + per-session isolation + fresh channels, WITHOUT loading a model
 * (`createServedContext`/`createServedReranker` need real weights; the pilot covers
 * those). Same "prove the plumbing without a model" discipline as the host tests.
 */
import { makeServedRunner, createServedChannels } from "./served-runtime";
import type { Config } from "./tui-ink";
import type { Reranker } from "@lloyal-labs/rig";

let failures = 0;
function ok(cond: boolean, msg: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

const cfg: Config = {
  version: 1,
  sources: {},
  apps: {},
  defaults: { reasoningMode: "flat", effort: "high", maxTurns: 10 },
  model: {
    path: "/models/llm.gguf",
    reranker: "/models/rerank.gguf",
    nCtx: 8192,
  },
};
// The runner only STORES the reranker (never calls it here) — shape stubs are fine.
// TWO distinct stubs stand in for two sessions' OWN per-session reranker contexts.
const rerankerA = {} as unknown as Reranker;
const rerankerB = {} as unknown as Reranker;

// ── channels ──
const ch = createServedChannels();
ok(typeof ch.uiChannel?.send === "function", "createServedChannels returns an EventBus uiChannel");
ok(typeof ch.commands?.send === "function", "createServedChannels returns a Command signal");

// ── runner shape (one Runner per Session) ──
const r1 = makeServedRunner(cfg, rerankerA);
ok(r1.mode === "interactive", "served runner mode = interactive");
ok(r1.reranker === rerankerA, "runner holds the per-session reranker it was built with");
ok(r1.isFirstIteration === true, "served runner isFirstIteration = true");
ok(r1.replayCheckpoint === null, "served runner has no replay checkpoint");
ok(r1.initialQuery === undefined, "served runner has no initialQuery");

// ── reloadRuntime is a no-op (fixed host residency) ──
r1.reloadRuntime({ model: { path: "/other.gguf" } });
ok(r1.config().model.path === "/models/llm.gguf", "reloadRuntime is a no-op (config unchanged)");

// ── saveConfig merges IN-MEMORY and returns a served SaveResult (no disk) ──
const res = r1.saveConfig({ sources: { outputDir: "/out" } });
ok(res.config.sources.outputDir === "/out", "saveConfig merges the patch");
ok(r1.config().sources.outputDir === "/out", "saveConfig reflected on this session");
ok(res.path === "<served>" && res.gitignored === false && res.skipped.length === 0, "saveConfig returns a served SaveResult (no disk write)");

// ── per-session isolation: a SECOND session with its OWN reranker ──
const r2 = makeServedRunner(cfg, rerankerB);
ok(r2.reranker === rerankerB && r1.reranker !== r2.reranker, "each session gets its OWN reranker (no shared instance)");
ok(r2.config().sources.outputDir === undefined, "a second session does NOT see S1's in-memory saveConfig");
ok(r1.config() !== r2.config(), "each session gets its own config clone");
ok(r1.windDown !== r2.windDown && r1.cancelAgent !== r2.cancelAgent, "wind-down / cancel signals are per-session");

// ── edge-loader parity: an empty-string path clears the key (fresh runner) ──
const rc = makeServedRunner(cfg, rerankerA);
ok(rc.saveConfig({ sources: { outputDir: "/x" } }).config.sources.outputDir === "/x", "saveConfig sets outputDir");
ok(rc.saveConfig({ sources: { outputDir: "" } }).config.sources.outputDir === undefined, "saveConfig clears outputDir on empty string (edge-loader parity)");

console.log(failures === 0 ? "all passed" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
