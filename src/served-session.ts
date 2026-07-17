/**
 * Served (B-host) placement — the harness-RUNNING half. Isolated from the
 * factories in `./served-runtime` because it imports the `harness` (and thus its
 * `.eta` prompts): anything importing this file must be esbuilt with
 * `--loader:.eta=text`, never run as raw `tsx`.
 */
import type { Operation } from "effection";
import { harness } from "./main";
import { RunnerCtx } from "./runner-ctx";
import {
  createServedReranker,
  makeServedRunner,
  type ServedSubstrate,
} from "./served-runtime";
import type { Config } from "./tui-ink";

/**
 * Run ONE served Session end to end: build its per-session reranker (its OWN KV
 * context over the shared resident weights — so tenant documents never cross the
 * reranker context) and served `Runner`, publish the runner on `RunnerCtx`, and run
 * the UNCHANGED `harness(...)` over this Session's substrate. The host `spawn`s this
 * as the per-session child; its scope owns BOTH the reranker resource (disposes on
 * teardown) and the `RunnerCtx` binding, so N sessions share no runner state and no
 * native reranker context.
 */
export function* runServedSession(
  cfg: Config,
  substrate: ServedSubstrate,
): Operation<void> {
  const reranker = yield* createServedReranker(cfg);
  const runner = makeServedRunner(cfg, reranker);
  yield* RunnerCtx.set(runner);
  yield* harness(substrate.context, substrate.uiChannel, substrate.commands);
}
