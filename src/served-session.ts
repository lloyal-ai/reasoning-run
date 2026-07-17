/**
 * Served (B-host) placement — the harness-RUNNING half. Isolated from the
 * factories in `./served-runtime` because it imports the `harness` (and thus its
 * `.eta` prompts): anything importing this file must be esbuilt with
 * `--loader:.eta=text`, never run as raw `tsx`.
 */
import type { Operation, Signal } from "effection";
import type { SessionContext } from "@lloyal-labs/sdk";
import type { EventBus } from "@lloyal-labs/binding";
import { harness } from "./main";
import { RunnerCtx } from "./runner-ctx";
import { createServedReranker, makeServedRunner } from "./served-runtime";
import type { WorkflowEvent, Command, Config } from "./tui-ink";

/**
 * Run ONE served Session end to end: build its per-session reranker (its OWN KV
 * context over the shared resident weights, so tenant documents never cross the
 * reranker context) and served `Runner`, publish the runner on `RunnerCtx`, and run
 * the UNCHANGED `harness(...)` over this Session. The host `spawn`s this as the
 * per-session child; its scope owns BOTH the reranker resource (disposes on
 * teardown) and the `RunnerCtx` binding, so N sessions share no runner state and no
 * native reranker context.
 *
 * The last three params ARE the `harness(ctx, events, commands)` signature — a
 * driver forwards the `{context, uiChannel, commands}` it materialised for the host.
 */
export function* runServedSession(
  cfg: Config,
  ctx: SessionContext,
  events: EventBus<WorkflowEvent>,
  commands: Signal<Command, void>,
): Operation<void> {
  const reranker = yield* createServedReranker(cfg);
  yield* RunnerCtx.set(makeServedRunner(cfg, reranker));
  yield* harness(ctx, events, commands);
}
