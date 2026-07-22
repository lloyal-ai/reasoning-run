/**
 * __serve-nsession — the FUSED Phase-1 box END-TO-END on a REAL model (Metal).
 *
 * Stage-3 verification #2: the model-free loopback (`__serve-loopback`) proves the driver's
 * WIRING; this proves the whole box on real weights — the driver + `@lloyal-labs/host` + a
 * real `ws` server + N `connectWss` clients, with the REAL `createServedContext` +
 * `runServedSession` (the injected harness). It asserts the properties nothing else covers
 * TOGETHER: N Sessions boot to `live` CONCURRENTLY over ONE resident model, the
 * `maxNativeSessions` cap holds (N+1th stays `queued`), a disconnect PROMOTES the queued
 * Session (FIFO), and a real query executes through the wss front door while a sibling
 * Session is live.
 *
 * ESBUILT (pulls `runServedSession` → the harness → its `.eta` prompts) — run via
 * `npm run test:serve-nsession`, NEVER tsx. Self-skips (exit 0) when weights are absent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { main, sleep, action, type Operation, type Signal } from "effection";
import { WebSocketServer } from "ws";
import type { WsServerSocket } from "@lloyal-labs/binding/node";
import { connectWss, type WssClient } from "@lloyal-labs/binding/web";
import type { EventBus } from "@lloyal-labs/binding";
import type { SessionState } from "@lloyal-labs/host";
import { createServedHostDriver } from "./serve/driver";
import { runServedSession } from "./served-session";
import type { Config, WorkflowEvent, Command } from "./tui-ink";

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
  console.log(`[serve-nsession] no weights (llm=${!!LLM} reranker=${!!RERANKER}) — skipping`);
  process.exit(0);
}

const MAX = 2; // the cap — N=3 clients (> cap) forces one to queue
const cfg: Config = {
  version: 1,
  sources: {},
  apps: {}, // no corpus config ⇒ the corpus app is not enabled
  defaults: { reasoningMode: "flat", effort: "low", maxTurns: 4 },
  model: { path: LLM, reranker: RERANKER, nCtx: 4096 },
};
const MINIMAL_QUERY = "Say hello in one short sentence."; // gate is EXECUTION, not text

function* waitFor(pred: () => boolean, label: string, timeoutMs: number): Operation<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor: "${label}" not met in ${timeoutMs}ms`);
    yield* sleep(50);
  }
}

// One client's observed state (its own connection ⇒ its own Session).
interface Client {
  id: number;
  client: WssClient<Command>;
  phases: string[];
  events: WorkflowEvent[];
  booted(): boolean; // harness reached the composer (weights loaded + runner/apps wired)
  live(): boolean;
  last(): string;
}

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

main(function* () {
  const driver = yield* createServedHostDriver(cfg, {
    maxNativeSessions: MAX,
    // The host erases the bus/command payload types to `unknown`; the driver created
    // these channels as WorkflowEvent/Command, so re-narrow them (see serve/main.ts).
    run: (m) =>
      runServedSession(
        cfg,
        m.context,
        m.uiChannel as unknown as EventBus<WorkflowEvent>,
        m.commands as unknown as Signal<Command, void>,
      ),
  });
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    driver.serveConnection(socket as unknown as WsServerSocket);
  });
  const port = yield* action<number>((resolve) => {
    const done = () => resolve((server.address() as AddressInfo).port);
    if (server.address()) done();
    else server.on("listening", done);
    return () => {};
  });

  const clients: Client[] = [];
  function connect(id: number): Client {
    const phases: string[] = [];
    const events: WorkflowEvent[] = [];
    let sawWeights = false;
    let sawComposer = false;
    const client = connectWss<WorkflowEvent, Command>(`ws://localhost:${port}`, {
      onSession: (s: SessionState) => phases.push(s.phase),
      onEvent: (e) => {
        events.push(e);
        if (e.type === "weights:done") sawWeights = true;
        if (e.type === "ui:composer") sawComposer = true;
      },
    });
    const c: Client = {
      id,
      client,
      phases,
      events,
      booted: () => sawWeights && sawComposer,
      live: () => phases.includes("live"),
      last: () => phases[phases.length - 1] ?? "",
    };
    clients.push(c);
    return c;
  }

  try {
    // ── 1. Connect N=3 (> cap 2). FIFO ⇒ clients 0,1 admitted, client 2 queued. ──
    const c0 = connect(0);
    const c1 = connect(1);
    const c2 = connect(2);

    // ── 2. Two boot to live CONCURRENTLY over ONE resident model; the third queues. ──
    yield* waitFor(
      () => c0.booted() && c1.booted(),
      "clients 0+1 both boot the real harness to the composer",
      240_000,
    );
    console.log(`[serve-nsession] occupancy=${driver.occupancy} phases: c2=[${c2.phases.join(">")}]`);
    check(c0.live() && c1.live(), "clients 0+1 reached `live` concurrently over one model");
    check(driver.occupancy === MAX, `occupancy === cap (${MAX})`);
    check(c2.last() === "queued", "client 2 (N+1th) is held `queued` behind the cap");

    // ── 3. Disconnect a LIVE Session → the queued one PROMOTES (FIFO), occupancy holds. ──
    c1.client.close();
    yield* waitFor(() => c2.booted(), "client 2 promotes queued→live + boots on the freed slot", 240_000);
    check(c2.live(), "client 2 promoted to `live` after client 1 disconnected (FIFO)");
    check(driver.occupancy === MAX, `occupancy back to cap (${MAX}) after promotion`);

    // ── 4. A real query executes through the wss front door while client 2 is live. ──
    // Gate on end-to-end EXECUTION (research:done + complete), NOT answer TEXT — a COLD
    // session runs single-task research whose synth answer is empty on a 4B (see Suite B).
    c0.client.send({ type: "submit_query", query: MINIMAL_QUERY, mode: "flat", skipPlanner: true });
    yield* waitFor(
      () => c0.events.some((e) => e.type === "complete"),
      "client 0's query runs end-to-end to `complete` over the served substrate",
      300_000,
    );
    check(
      c0.events.some((e) => e.type === "research:done"),
      "client 0's multi-agent pipeline ran to research:done through the wss front door",
    );
    console.log(`[serve-nsession] c0 pipeline: ${c0.events.map((e) => e.type).join(" → ")}`);

    for (const c of clients) c.client.close();
    console.log(failures === 0 ? "[serve-nsession] all passed" : `[serve-nsession] ${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1); // clean exit before native destructors
  } catch (err) {
    console.error(`[serve-nsession] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    for (const c of clients) console.error(`  client ${c.id}: phases=[${c.phases.join(">")}] events=${c.events.length}`);
    process.exit(1);
  }
});
