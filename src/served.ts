/**
 * reasoning.run's `./runner` subpath — the served (B-host) placement surface.
 *
 * The reasoning.run-specific half a model-runtime host injects: build the
 * per-session compute substrate over ONE resident model, a per-session reranker
 * (its own KV context over the shared resident weights), and the served `Runner`
 * the harness reads from `RunnerCtx`. A driver assembles
 * `@lloyal-labs/host`'s `ServedHarness { materialise, run }` from these — the host
 * imports none of it, so neither side imports the other.
 *
 * Split note: the harness-FREE factories live in `./served-runtime` (importable
 * under `tsx`); {@link runServedSession} lives in `./served-session` (imports the
 * harness + its `.eta` prompts → must be esbuilt). This index re-exports both, so a
 * driver that imports `reasoning.run/runner` gets the whole surface (and bundles it).
 */
export {
  createServedContext,
  createServedReranker,
  makeServedRunner,
  createServedChannels,
  type ServedSubstrate,
} from "./served-runtime";
export { runServedSession } from "./served-session";
export { RunnerCtx } from "./runner-ctx";
export type { Runner } from "./runner-ctx";
