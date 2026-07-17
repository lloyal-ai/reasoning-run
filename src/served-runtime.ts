/**
 * Served (B-host) placement — the harness-FREE half: the per-session compute
 * substrate + the served `Runner` factory. Kept separate from {@link runServedSession}
 * (which imports the `harness` + its `.eta` prompts, so it must be esbuilt) so these
 * factories stay importable under plain `tsx` and unit-testable without a model.
 *
 * Under Placement B one process holds ONE resident model (lloyal.node's native
 * ModelRegistry weak-caches it by path) and N `SessionContext`s each run an
 * UNCHANGED harness scope over it — "one harness → many users". A driver assembles
 * `@lloyal-labs/host`'s `ServedHarness { materialise, run }` from these pieces: it
 * imports NONE of this by name — the split is a DI seam, so neither the host nor
 * reasoning.run imports the other.
 */
import { createSignal } from "effection";
import type { Signal } from "effection";
import { createContext } from "@lloyal-labs/lloyal.node";
import type { SessionContext } from "@lloyal-labs/sdk";
import { createReranker } from "@lloyal-labs/rig/node";
import type { Reranker } from "@lloyal-labs/rig";
import { NullTraceWriter } from "@lloyal-labs/lloyal-agents";
import { createBus, type EventBus } from "@lloyal-labs/binding";
import type { Operation } from "effection";
import type { Runner } from "./runner-ctx";
import type { WorkflowEvent, Command, Config } from "./tui-ink";
import type { ConfigOrigin } from "./tui-ink/config";

/**
 * Build one `SessionContext` over the resident model. Called once per admitted
 * Session (in the host's `materialise`); lloyal.node's ModelRegistry weak-caches
 * the model by path, so the Nth call shares the same resident weights and only
 * allocates a fresh KV context. Params are reasoning.run's own (mirrors the edge
 * runner: 64 branch leases, q4_0 KV, nCtx from config).
 */
export function createServedContext(cfg: Config): Promise<SessionContext> {
  const modelPath = cfg.model.path;
  if (!modelPath) {
    throw new Error(
      "createServedContext: cfg.model.path is required (the host's resident model)",
    );
  }
  return createContext(
    {
      modelPath,
      nCtx: cfg.model.nCtx ?? 32768,
      nSeqMax: 64,
      typeK: "q4_0",
      typeV: "q4_0",
    },
    // Explicit backend variant beats env inside lloyal.node. On Metal (the pilot)
    // gpu is unset and the default backend loads; a CUDA host sets the variant.
    cfg.model.gpu ? { gpuVariant: cfg.model.gpu } : undefined,
  );
}

/**
 * Build THIS Session's cross-encoder — its OWN KV context over the SHARED resident
 * reranker weights. lloyal.node's native `ModelRegistry` weak-caches the
 * `llama_model` by (path, gpu, mmap), so the first session loads the weights and
 * every later session reuses them; each session pays only its own context. An
 * Effection resource yielded in the SESSION scope (see `runServedSession`) so user
 * documents never cross the reranker context between tenants and it disposes on
 * session teardown. Per-session — NOT host-shared: a shared reranker context would
 * both serialize every tenant's rerank work and coresident their documents.
 * Params are reasoning.run's own (nSeqMax 10 — the rerank architecture spends 2
 * leases on trunk + queryBranch, keeping 8 scoring leaves).
 */
export function* createServedReranker(cfg: Config): Operation<Reranker> {
  const rerankPath = cfg.model.reranker;
  if (!rerankPath) {
    throw new Error("createServedReranker: cfg.model.reranker is required");
  }
  return yield* createReranker(rerankPath, {
    nSeqMax: 10,
    nCtx: 16384,
  });
}

// A served config isn't sourced from CLI/env/file — it's deploy state. Every field
// reads as `default` for the composer's provenance hints.
const SERVED_ORIGIN: ConfigOrigin = {
  reasoningMode: "default",
  modelPath: "default",
  reranker: "default",
  nCtx: "default",
  gpu: "default",
  outputDir: "default",
};

/** Deep-merge a `saveConfig` patch into a served config — same nested-object merge
 *  the file loader uses (`config.ts` `readFileIfExists`), but purely in-memory. */
function mergeServedConfig(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    sources: { ...base.sources, ...(patch.sources ?? {}) },
    apps: { ...base.apps, ...(patch.apps ?? {}) },
    defaults: { ...base.defaults, ...(patch.defaults ?? {}) },
    model: { ...base.model, ...(patch.model ?? {}) },
  };
}

/**
 * Build the served `Runner` for ONE Session. Everything here is per-session: its
 * OWN config clone (so an in-memory `saveConfig` — e.g. /output-dir — is
 * session-local), its OWN `reranker` (a per-session context, built in
 * `runServedSession`), fresh wind-down / cancel signals, and a null trace sink — so
 * no runner state and no user data crosses between tenants. `reloadRuntime` is a
 * no-op: the model is a fixed host residency, so a /model or /gpu change can't
 * rebuild it — the harness's unconditional `return` after calling it simply ends
 * that Session.
 */
export function makeServedRunner(cfg: Config, reranker: Reranker): Runner {
  let sessionConfig = structuredClone(cfg);
  const windDown = createSignal<void, void>();
  const cancelAgent = createSignal<{ agentId: number }, void>();
  const traceWriter = new NullTraceWriter();
  return {
    config: () => sessionConfig,
    origin: () => SERVED_ORIGIN,
    saveConfig(patch) {
      sessionConfig = mergeServedConfig(sessionConfig, patch);
      return {
        path: "<served>",
        gitignored: false,
        skipped: [],
        config: sessionConfig,
        origin: SERVED_ORIGIN,
      };
    },
    reloadRuntime() {
      // No-op — the model is a fixed host residency; it can't rebuild per
      // Session. The harness `return`s right after calling this, ending the
      // Session cleanly (the host reaps it + frees the context).
    },
    reranker,
    windDown,
    cancelAgent,
    traceWriter,
    replayCheckpoint: null,
    findingsMaxChars: undefined,
    mode: "interactive",
    initialQuery: undefined,
    isFirstIteration: true,
  };
}

/** Build a fresh per-session event bus + command signal (reasoning.run's own
 *  channel types). A driver pairs this with {@link createServedContext} to satisfy
 *  the host's `materialise`. */
export function createServedChannels(): {
  uiChannel: EventBus<WorkflowEvent>;
  commands: Signal<Command, void>;
} {
  return {
    uiChannel: createBus<WorkflowEvent>(),
    commands: createSignal<Command, void>(),
  };
}
