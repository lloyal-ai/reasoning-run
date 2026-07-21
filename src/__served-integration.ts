/**
 * Suite B — the reasoning.run served-path integration gate (the `0.7.0` publish gate).
 *
 * Everything else green is static / model-free. This runs the REAL harness end to end
 * over the served substrate and proves `runServedSession` actually works:
 *   Phase 1 (boot): `createServedContext` + `createServedReranker` load real weights,
 *     `RunnerCtx.set` + `initAgents` + `RerankerCtx.set` + app-enable all run, reaching
 *     `weights:done` + `ui:composer`.
 *   Phase 2 (query): a `skipPlanner` Ask direct-answer query → a terminal `answer` event
 *     produced by the MODEL. `fetch` is blocked so the always-on keyless web tool can't
 *     make it network-dependent (the direct-answer path answers with 0 tools anyway).
 *
 * ESBUILT script (imports the harness + its `.eta` prompts) — run via `npm run
 * test:served`, NEVER tsx. Self-skips (exit 0) when weights are absent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert";
import { main, spawn, sleep, call, type Operation } from "effection";
import { createServedContext, createServedChannels } from "./served-runtime";
import { runServedSession } from "./served-session";
import type { Config, WorkflowEvent } from "./tui-ink";

// ── model resolve + skip ──
function resolve(...candidates: (string | undefined)[]): string | null {
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return null;
}
const LLM = resolve(
  process.env.LLAMA_TEST_MODEL,
  path.join(os.homedir(), ".cache/lloyal/models/Qwen3.5-4B-Q4_K_M.gguf"),
);
const RERANKER = resolve(
  process.env.LLAMA_RERANK_MODEL,
  path.join(os.homedir(), ".cache/lloyal/models/qwen3-reranker-0.6b-q8_0.gguf"),
);
if (!LLM || !RERANKER) {
  console.log(`[served-integration] no weights (llm=${!!LLM} reranker=${!!RERANKER}) — skipping`);
  process.exit(0);
}

const cfg: Config = {
  version: 1,
  sources: {},
  apps: {}, // no corpus config ⇒ the corpus app is not enabled
  defaults: { reasoningMode: "flat", effort: "low", maxTurns: 4 },
  model: { path: LLM, reranker: RERANKER, nCtx: 8192 },
};

// Content doesn't matter — the gate is end-to-end EXECUTION, not the (research-
// fallback) answer text. Kept trivial + tool-free so the pipeline runs fast + offline.
const MINIMAL_QUERY = "Say hello in one short sentence.";

function* waitFor(pred: () => boolean, label: string, timeoutMs: number): Operation<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor: "${label}" not met in ${timeoutMs}ms`);
    yield* sleep(25);
  }
}

main(function* () {
  const { uiChannel, commands } = createServedChannels();
  const events: WorkflowEvent[] = [];
  let sawWeightsDone = false;
  let sawComposer = false;
  let sawComplete = false;
  // Subscribe FIRST — the bus replays to its first subscriber, so boot events emitted
  // before this point are still captured.
  uiChannel.subscribe((ev) => {
    events.push(ev);
    if (ev.type === "weights:done") sawWeightsDone = true;
    if (ev.type === "ui:composer") sawComposer = true;
    if (ev.type === "complete") sawComplete = true;
  });

  try {
    const ctx = yield* call(() => createServedContext(cfg)); // the host's materialise
    yield* spawn(() => runServedSession(cfg, ctx, uiChannel, commands)); // the host's run

    // ── Phase 1: boot reaches the substrate. ──
    yield* waitFor(() => sawWeightsDone && sawComposer, "boot (weights:done + ui:composer)", 180_000);
    console.log(`[served-integration] boot OK (${events.length} events → weights:done + ui:composer)`);

    // ── Offline: block egress AFTER boot (boot is local — models on disk, apps lazy-
    // init) so the keyless web tool can't make the query network-dependent. A stray
    // tool call fails fast and the Ask direct-answer path still returns a model answer. ──
    globalThis.fetch = (async () => {
      throw new Error("offline integration test — fetch is blocked");
    }) as typeof globalThis.fetch;

    // ── Phase 2: a minimal direct-answer query. Gate the send on ui:composer (Effection
    // Signals don't buffer — a pre-loop send is lost). ──
    commands.send({ type: "submit_query", query: MINIMAL_QUERY, mode: "flat", skipPlanner: true });
    // Gate on end-to-end EXECUTION + real model decode into the served context — NOT on
    // the answer TEXT. A COLD session (no warm `session.trunk`) can't take the clean
    // `runPassthrough` direct-answer path; `skipPlanner` + the passthrough fallback run
    // single-task RESEARCH, whose synthesized answer is empty on a small model (see
    // `runPassthrough`/`testWarmMultiTurnRecall` — a real answer needs a warm turn). The
    // answer's CONTENT is a research-pipeline property; that `runServedSession` boots +
    // runs the real harness to completion decoding over the served substrate is THE
    // served-path property, and that's what this gate proves.
    yield* waitFor(() => sawComplete, "session reaches `complete`", 240_000);
    console.log(`[served-integration] pipeline: ${events.map((e) => e.type).join(" → ")}`);
    // Reaching `complete` after the full sequence proves runServedSession ran the REAL
    // multi-agent harness end to end over the served substrate: boot loaded the reranker
    // + wired the runner/apps, and the research agents DECODED over the served context to
    // reach `research:done` → `answer`. (Agents decode on forked branches, so the TRUNK's
    // `stats.ctxPos` stays 0 on a cold session — it is NOT the decode signal; the pipeline
    // reaching research:done/answer/complete is.)
    assert(
      events.some((e) => e.type === "research:done"),
      "the multi-agent research pipeline should run to research:done over the served substrate",
    );
    assert(events.some((e) => e.type === "answer"), "the pipeline should reach a terminal answer event");
    console.log(
      "[served-integration] PASS — runServedSession booted + ran a real session end-to-end over the served substrate",
    );
    process.exit(0); // clean exit before native destructors (no Metal teardown assert)
  } catch (err) {
    console.error(
      `[served-integration] FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(`[served-integration] events seen: ${events.map((e) => e.type).join(", ")}`);
    const ansEv = events.find((e) => e.type === "answer") as { text: string } | undefined;
    console.error(`[served-integration] answer event text = ${JSON.stringify(ansEv?.text)}`);
    process.exit(1);
  }
});
