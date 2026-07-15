/**
 * The runner ↔ harness seam (reasoning.run-internal — NOT the platform contract).
 *
 * The Layer-2 *runner* (`runMain` in `main.ts`) sets `RunnerCtx`; the Layer-3
 * `harness(ctx, events, commands)` (also in `main.ts`) reads it. It is how
 * reasoning.run's own runner hands its harness the edge-shell concerns the
 * harness cannot own: the loaded runtime handles it doesn't create (the reranker
 * + the persistent wind-down / cancel signals), the live resolved config, config
 * persistence (`harness.json`), and the model-reload restart request — the runner
 * owns the `SessionContext` lifetime, so a /model, /reranker or /gpu change
 * resolves the harness and the runner rebuilds on a fresh context.
 *
 * When the served (B-host) placement lands, reasoning.run's OWN runner runs there
 * too — the host instantiates `harness(...)` (the platform contract) and this same
 * runner, in its served variant, supplies a trivial `Runner`: config from deploy
 * state, `saveConfig`/`reloadRuntime` ephemeral or rejected (the host
 * re-materialises the Session), no replay, `interactive`. That path is NOT wired
 * yet, so `RunnerCtx`/`Runner` stay deliberately unexported (no `./runner` subpath) —
 * today `runMain` (edge/CLI) is the only runner, and it sits in this same package.
 */
import { createContext, type Signal } from "effection";
import type { Config } from "./tui-ink";
import type { ConfigOrigin, SaveResult } from "./tui-ink/config";
import type { TraceWriter, BranchCheckpoint } from "@lloyal-labs/lloyal-agents";
import type { Reranker } from "@lloyal-labs/rig";

export interface Runner {
  /** The live, resolved config (CLI > env > file > default). */
  config(): Config;
  /** Provenance of each resolved config field (for `config:updated` echoes). */
  origin(): ConfigOrigin;
  /** Persist a config patch to the `harness.json` layer + reload; returns the new
   *  resolved state. Edge-only in practice — never sent over the served wire. */
  saveConfig(
    patch: Partial<Config>,
  ): SaveResult & { config: Config; origin: ConfigOrigin };
  /** Persist a model/reranker/gpu change and request a runtime restart: the runner
   *  tears down the current `SessionContext` + rebuilds, then re-instantiates
   *  `harness` on the new context. The harness returns after calling this. No-op on
   *  a served runner (the model is a fixed host residency). */
  reloadRuntime(patch: Partial<Config>): void;
  /** The loaded cross-encoder — the harness publishes it on `RerankerCtx` for its
   *  AgentApps. Runner-owned (created in the boot loop) so its lifetime is the
   *  runner's; a served runner supplies the host's resident reranker. */
  reranker: Reranker;
  /** Persistent graceful-wind-down signal (one per process, survives restarts). */
  windDown: Signal<void, void>;
  /** Persistent per-agent cancel signal (one per process, survives restarts). */
  cancelAgent: Signal<{ agentId: number }, void>;
  /** Observability sink threaded into `initAgents`. */
  traceWriter: TraceWriter;
  /** Replay-mode spine checkpoint (edge `--replay-trace`); null normally + served. */
  replayCheckpoint: BranchCheckpoint | null;
  /** `--findings-budget` cap (edge flag); undefined = default. */
  findingsMaxChars: number | undefined;
  /** 'oneshot' = non-TTY `--query`/JSONL (run once, no plan-review gate);
   *  'interactive' = Ink or the fork-IPC / wss bridge (the command loop). */
  mode: "interactive" | "oneshot";
  /** The `--query` to auto-submit (interactive, first iteration) or run (oneshot). */
  initialQuery: string | undefined;
  /** True only on the runner's first boot iteration — gates the `--query` auto-submit. */
  isFirstIteration: boolean;
}

export const RunnerCtx = createContext<Runner>("reasoning.run.runner");
