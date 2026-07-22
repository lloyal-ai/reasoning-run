/**
 * `bin/serve.js`'s entry — the reasoning.run served-host runner. Stands up a `ws` server
 * that serves N Sessions over ONE resident model (Placement B, fused Phase-1: the
 * model-runtime host + the wss front door in one process).
 *
 * ESBUILT (it injects `runServedSession` → the harness → its `.eta` prompts, so it must
 * bundle with `--loader:.eta=text`, never tsx). Config from env; localhost / no-auth for
 * the pilot — token auth is a front-door concern, deferred.
 */
import { main, suspend } from "effection";
import type { Signal } from "effection";
import { WebSocketServer } from "ws";
import type { WsServerSocket } from "@lloyal-labs/binding/node";
import type { EventBus } from "@lloyal-labs/binding";
import { createServedHostDriver } from "./driver";
import { runServedSession } from "../served-session";
import type { Config, WorkflowEvent, Command } from "../tui-ink";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function resolveConfig(): Config {
  const modelPath = process.env.LLOYAL_MODEL ?? process.env.LLAMA_TEST_MODEL;
  const reranker = process.env.LLOYAL_RERANKER ?? process.env.LLAMA_RERANK_MODEL;
  if (!modelPath || !reranker) {
    throw new Error(
      "serve: set LLOYAL_MODEL + LLOYAL_RERANKER (the resident model + reranker .gguf paths)",
    );
  }
  return {
    version: 1,
    sources: {},
    apps: {},
    defaults: { reasoningMode: "flat", effort: "high", maxTurns: 10 },
    model: { path: modelPath, reranker, nCtx: envInt("LLOYAL_NCTX", 32768) },
  };
}

main(function* () {
  const cfg = resolveConfig();
  const port = envInt("PORT", 8787);
  const maxNativeSessions = envInt("MAX_SESSIONS", 8);
  // Default to loopback: the pilot is no-auth, and ws's default all-interfaces bind for
  // `{ port }` would expose an unauthenticated model service on the LAN. `HOST=0.0.0.0`
  // is an explicit opt-in once an operator fronts it with auth/TLS.
  const bindHost = process.env.HOST ?? "127.0.0.1";

  const driver = yield* createServedHostDriver(cfg, {
    maxNativeSessions,
    // The host is payload-opaque — it erases the bus/command types to `unknown`. The
    // driver created these channels as WorkflowEvent/Command, so re-narrow them here.
    run: (m) =>
      runServedSession(
        cfg,
        m.context,
        m.uiChannel as unknown as EventBus<WorkflowEvent>,
        m.commands as unknown as Signal<Command, void>,
      ),
  });

  const server = new WebSocketServer({ port, host: bindHost });
  // Server-level errors are almost always a bind failure (EADDRINUSE / EACCES). Without a
  // listener Node rethrows the EventEmitter 'error' as an uncaught exception with a bare
  // stack — surface an actionable message + exit non-zero for the operator/orchestrator.
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[serve] failed to bind ${bindHost}:${port} — ${err.code ?? err.message}`);
    process.exit(1);
  });
  server.on("connection", (socket) => {
    // The `ws` socket structurally satisfies binding's `WsServerSocket` (send + on
    // message/close), but binding doesn't attach a `ws` 'error' handler — an unhandled
    // 'error' on a Node EventEmitter throws, so the host must.
    socket.on("error", () => {});
    driver.serveConnection(socket as unknown as WsServerSocket);
  });
  // Plaintext ws:// — TLS terminates upstream (reverse proxy / the managed front door),
  // never in this process, so label it "ws" (not "wss") for operators.
  console.log(
    `[serve] ws listening on ${bindHost}:${port} — up to ${maxNativeSessions} sessions over ${cfg.model.path}`,
  );

  yield* suspend(); // run until the process is signalled (main handles SIGINT/SIGTERM)
});
