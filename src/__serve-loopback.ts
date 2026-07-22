/**
 * __serve-loopback — the served-host driver's wire contract, MODEL-FREE.
 *
 * The binding wss⇄connectWss envelope is already proven in binding/relay; this proves the
 * DRIVER's wiring: `serveConnection` (eager channels → `wss()` → `host.admit` →
 * `onState`→`postSession`, `close`→`host.release`). Drives the REAL `createServedHostDriver`
 * with a FAKE harness (no model) through a REAL `ws` server + the REAL `connectWss` client,
 * asserting both wire directions + the session lifecycle.
 *
 * `driver.ts` is harness-free (the harness `run` is injected here as a fake), so this runs
 * under plain `tsx` — no esbuild / `.eta`.
 */
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { main, sleep, each, action, type Operation } from "effection";
import { WebSocketServer } from "ws";
import type { WsServerSocket } from "@lloyal-labs/binding/node";
import { connectWss } from "@lloyal-labs/binding/web";
import type { Materialised, SessionState } from "@lloyal-labs/host";
import type { SessionContext } from "@lloyal-labs/sdk";
import { createServedHostDriver } from "./serve/driver";
import type { Config, WorkflowEvent, Command } from "./tui-ink";

const cfg: Config = {
  version: 1,
  sources: {},
  apps: {},
  defaults: { reasoningMode: "flat", effort: "low", maxTurns: 2 },
  model: { path: "/fake/model.gguf", reranker: "/fake/reranker.gguf", nCtx: 2048 },
};

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

function* waitFor(pred: () => boolean, label: string, timeoutMs = 5000): Operation<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor: "${label}" not met in ${timeoutMs}ms`);
    yield* sleep(10);
  }
}

main(function* () {
  const received: Command[] = [];
  // Fake harness `run` (mirrors runServedSession's ordering): emit the boot events, then
  // subscribe + loop on commands. `yield* each()` SUSPENDS to establish the subscription,
  // so it must follow `ui:composer` — the client only sends after it sees `ui:composer`,
  // and that command's WS round-trip (many ticks) dwarfs the one-tick subscription setup,
  // so no command is lost.
  function* fakeRun(m: Materialised<SessionContext>): Operation<void> {
    m.uiChannel.send({ type: "weights:done" });
    m.uiChannel.send({ type: "ui:composer" });
    for (const c of yield* each(m.commands)) {
      const cmd = c as Command;
      received.push(cmd);
      if (cmd.type === "submit_query") m.uiChannel.send({ type: "answer", text: "echo" });
      yield* each.next();
    }
  }

  const driver = yield* createServedHostDriver(cfg, {
    maxNativeSessions: 2,
    buildContext: async () => ({ dispose() {} }) as unknown as SessionContext,
    run: (m) => fakeRun(m),
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

  // ── connect a REAL client (node's global WebSocket via connectWss) ──
  const states: SessionState[] = [];
  const events: WorkflowEvent[] = [];
  let ready = false;
  const client = connectWss<WorkflowEvent, Command>(`ws://localhost:${port}`, {
    onEvent: (e) => events.push(e),
    onSession: (s) => states.push(s),
    onReady: () => {
      ready = true;
    },
  });

  yield* waitFor(
    () => ready && states.some((s) => s.phase === "live") && events.some((e) => e.type === "ui:composer"),
    "session live + boot events",
  );
  console.log(`[serve-loopback] session plane: ${states.map((s) => s.phase).join(" → ")}`);
  check(ready, "client onReady fired (transport ready)");
  check(
    states.some((s) => s.phase === "warming") && states.some((s) => s.phase === "live"),
    "session plane warming → live reached the client",
  );
  check(
    events.some((e) => e.type === "weights:done") && events.some((e) => e.type === "ui:composer"),
    "harness boot events streamed to the client",
  );
  check(driver.occupancy === 1, "driver occupancy === 1");

  // ── command up-channel: client → wss → dispatch → harness ──
  client.send({ type: "submit_query", query: "hi", mode: "flat", skipPlanner: true });
  yield* waitFor(
    () => received.some((c) => c.type === "submit_query") && events.some((e) => e.type === "answer"),
    "command reached the harness + answer streamed back",
  );
  check(received.some((c) => c.type === "submit_query"), "client command reached the harness");
  check(events.some((e) => e.type === "answer"), "harness answer streamed back to the client");

  // ── disconnect → release frees the slot ──
  client.close();
  yield* waitFor(() => driver.occupancy === 0, "release freed the slot on disconnect");
  check(driver.occupancy === 0, "driver occupancy === 0 after client close (release)");

  server.close();
  console.log(failures === 0 ? "all passed" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
