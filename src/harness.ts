/**
 * Harness — pipeline that turns a user query into an answer.
 *
 * Two public Operations:
 *
 *   runQuery(query, ...)          — runs the planner, dispatches on intent.
 *                                    Handles passthrough internally; returns
 *                                    a research plan for callers to route
 *                                    (plan-review dialog or direct execution).
 *
 *   runResearchPlan(query, plan,..) — runs research → maybe-synth → finalize
 *                                    for an already-vetted plan. Used by the
 *                                    accept_plan path (after plan-review) and
 *                                    by the START path (synthetic 1-task plan
 *                                    bypassing the planner).
 *
 * Two structural gates encode invariants, not user-mode flags:
 *
 *   1. session.trunk gates the passthrough fast-path. Without a warm trunk
 *      there's nothing to fork from; the pipeline falls through to research
 *      transparently. This is what makes first-query START work without any
 *      special-case — START produces a research plan, falls into Stage 4.
 *
 *   2. plan.tasks.length > 1 gates synth. Synth aggregates findings across
 *      multiple agents into one argument. With a single agent there's
 *      nothing to aggregate — that agent's report IS the answer. The synth
 *      prompts also assume multi-agent framing ("findings from N parallel
 *      research agents"), so running synth on a single source produces
 *      awkward output.
 */

import { call } from "effection";
import type { Operation } from "effection";
import type { Session, SessionContext } from "@lloyal-labs/sdk";
import {
  Ctx,
  Events,
  agentPool,
  useAgent,
  chain,
  parallel,
  renderTemplate,
  withSpine,
  DefaultAgentPolicy,
} from "@lloyal-labs/lloyal-agents";
import type { Source, AgentEvent } from "@lloyal-labs/lloyal-agents";
import type { StepEvent, OpTiming } from "./tui-ink";
import { reportTool, PlanTool } from "@lloyal-labs/rig";
import type {
  PlanResult,
  ResearchTask,
  Reranker,
  Chunk,
  SourceContext,
} from "@lloyal-labs/rig";
import { taskToContent } from "@lloyal-labs/rig";

// ── Prompts ─────────────────────────────────────────────────────
//
// .eta files are inlined into the published bundle as string constants
// via esbuild's text loader. At dev time tsx honors the same `*.eta` ->
// string contract via the eta.d.ts ambient declaration. No
// fs.readFileSync, no shipped prompts/ directory at runtime.

import PLAN_RAW from "./prompts/plan.eta";
import PLAN_FLAT_RAW from "./prompts/plan-flat.eta";
import FALLBACK_RAW from "./prompts/fallback.eta";
import RECOVERY_RAW from "./prompts/recovery.eta";
import SYNTHESIZE_RAW from "./prompts/synthesize.eta";
import SYNTHESIZE_FLAT_RAW from "./prompts/synthesize-flat.eta";
import CORPUS_WORKER_RAW from "./prompts/corpus-worker.eta";
import WEB_WORKER_RAW from "./prompts/web-worker.eta";
import PLAYBOOKS_RAW from "./prompts/playbooks.eta";

function parsePrompt(raw: string): { system: string; user: string } {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf("\n---\n");
  if (sep === -1) return { system: trimmed, user: "" };
  return {
    system: trimmed.slice(0, sep).trim(),
    user: trimmed.slice(sep + 5).trim(),
  };
}

const PLAN_DEEP = parsePrompt(PLAN_RAW);
const PLAN_FLAT = parsePrompt(PLAN_FLAT_RAW);
const FALLBACK = parsePrompt(FALLBACK_RAW);
const RECOVERY = parsePrompt(RECOVERY_RAW);
const SYNTHESIZE_DEEP = parsePrompt(SYNTHESIZE_RAW);
const SYNTHESIZE_FLAT = parsePrompt(SYNTHESIZE_FLAT_RAW);
const CORPUS_WORKER_TEMPLATE = CORPUS_WORKER_RAW;
const WEB_WORKER_TEMPLATE = WEB_WORKER_RAW;
const PLAYBOOKS_TEMPLATE = PLAYBOOKS_RAW;

function createResearchPolicy(): DefaultAgentPolicy {
  return new DefaultAgentPolicy({
    budget: {
      context: { softLimit: 2048, hardLimit: 1024 },
      time: { softLimit: 240_000, hardLimit: 360_000 },
    },
    recovery: { prompt: RECOVERY },
    terminalToolName: "report",
  });
}

/**
 * Synth policy — synth's entire output IS the answer. There's no tool-call
 * disambiguation to do (synth has no tools), so end-of-generation is the
 * natural terminal signal. The streamed content becomes `agent.result`
 * directly via the `free_text_report` action.
 *
 * `DefaultAgentPolicy._handleNoToolCall` gates `free_text_report` behind
 * `agent.toolCallCount > 0` — a guard against research agents skipping
 * evidence-gathering. Synth doesn't gather evidence; the prompt + parent
 * KV ARE the evidence. Bypass that guard here.
 */
class SynthPolicy extends DefaultAgentPolicy {
  override onProduced(
    ...args: Parameters<DefaultAgentPolicy["onProduced"]>
  ): ReturnType<DefaultAgentPolicy["onProduced"]> {
    const [, parsed] = args;
    if (!parsed.toolCalls[0] && parsed.content) {
      return { type: "free_text_return", content: parsed.content };
    }
    return super.onProduced(...args);
  }
}

// ── Public types ────────────────────────────────────────────────

export type QueryResult =
  | { type: "done" }
  | { type: "clarify"; plan: PlanResult }
  | { type: "research_plan"; plan: PlanResult };

export interface HarnessOpts {
  maxTurns: number;
  findingsMaxChars?: number;
  reasoningMode: "flat" | "deep";
}

export interface RunQueryOpts extends HarnessOpts {
  /** Extra context appended to the planner prompt — used to thread
   *  clarification Q&A back in for re-planning. */
  context?: string;
  /** performance.now() at the user's submit. Used as the `wallTimeMs`
   *  baseline in the `complete` event. */
  wallStartMs: number;
  /** Fires after the clarify gate but before passthrough/research starts.
   *  Used by main.ts to start the run-dir for artifact writes. */
  onStart?: () => void;
}

export interface RunResearchPlanOpts extends HarnessOpts {
  wallStartMs: number;
}

// ── Helpers ─────────────────────────────────────────────────────

interface WorkerPromptCtx extends Record<string, unknown> {
  maxTurns: number;
  agentCount: number;
  siblingTasks: string[];
  date: string;
  taskIndex?: number;
}

function renderWorkerPrompt(
  source: { name: string; promptData?: () => { toc: string } },
  ctx: WorkerPromptCtx,
): string {
  if (source.promptData) {
    return renderTemplate(CORPUS_WORKER_TEMPLATE, {
      ...source.promptData(),
      ...ctx,
    });
  }
  if (source.name === "web") {
    return renderTemplate(WEB_WORKER_TEMPLATE, ctx);
  }
  return FALLBACK.system;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function startTimer(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}

/**
 * Synthetic single-task research plan. Used by the START path to
 * bypass the planner — the user's literal query becomes the only
 * research task. Combined with the synth gate inside runResearchPlan
 * (skips synth when tasks.length === 1), this collapses START into
 * "research the literal query, return the agent's report."
 */
export function singleTaskPlan(query: string): PlanResult {
  return {
    intent: "research",
    tasks: [{ description: query }],
    clarifyQuestions: [],
    tokenCount: 0,
    timeMs: 0,
  };
}

/**
 * Passthrough — stream a direct answer from session.trunk after appending
 * the user's query as a fresh user turn. No research pool runs; the
 * answer comes from the prior Q&A already in trunk's KV.
 *
 * Caller ensures session.trunk exists; this throws otherwise.
 */
function* runPassthrough(
  query: string,
  session: Session,
): Operation<{ answer: string; tokenCount: number; timeMs: number }> {
  const trunk = session.trunk;
  if (!trunk) {
    throw new Error("runPassthrough: session has no trunk");
  }

  const ctx: SessionContext = yield* Ctx.expect();
  const sep = ctx.getTurnSeparator();
  const { prompt } = ctx.formatChatSync(
    JSON.stringify([{ role: "user", content: query }]),
    { addGenerationPrompt: true, enableThinking: false },
  );
  const userTurnTokens = [...sep, ...ctx.tokenizeSync(prompt, false)];
  yield* call(() => trunk.prefill(userTurnTokens));

  const t = performance.now();
  let tokenCount = 0;
  const pieces: string[] = [];
  for (;;) {
    const { token, text, isStop } = trunk.produceSync();
    if (isStop) break;
    yield* call(() => trunk.commit(token));
    tokenCount++;
    pieces.push(text);
  }
  return { answer: pieces.join(""), tokenCount, timeMs: performance.now() - t };
}

/**
 * Run the planner LLM. Emits a `query` event and a `plan` event.
 * Returns the raw PlanResult so callers can route based on intent.
 */
export function* runPlanner(
  query: string,
  session: Session,
  opts: { reasoningMode: "flat" | "deep"; context?: string },
): Operation<PlanResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  yield* send({ type: "query", query, warm: !!session.trunk });

  const currentDate = today();
  const planPrompt = opts.reasoningMode === "flat" ? PLAN_FLAT : PLAN_DEEP;
  const planTool = new PlanTool({
    prompt: planPrompt,
    session,
    maxQuestions: 10,
  });
  const planContext = opts.context
    ? `Today's date: ${currentDate}\n\n${opts.context}`
    : `Today's date: ${currentDate}`;
  const plan = (yield* planTool.execute({
    query,
    context: planContext,
  })) as PlanResult;

  yield* send({
    type: "plan",
    intent: plan.intent,
    tasks: plan.tasks,
    clarifyQuestions: plan.clarifyQuestions,
    tokenCount: plan.tokenCount,
    timeMs: plan.timeMs,
  });

  return plan;
}

// ── Pipeline ────────────────────────────────────────────────────

/**
 * Top of pipeline: run planner, dispatch on intent.
 *
 *   - intent='clarify'      → return; caller drives the clarify dialog
 *   - intent='passthrough'  → run passthrough inline (if trunk exists),
 *                             return done. If no trunk, fall through to
 *                             research_plan with a single-task synthetic
 *                             plan since passthrough requires a warm
 *                             session.
 *   - intent='research'     → return the plan; caller decides whether to
 *                             show plan-review or run it directly.
 *
 * For START (skip planner): main.ts builds a singleTaskPlan(query) and
 * calls runResearchPlan directly — never enters this function.
 */
export function* runQuery(
  query: string,
  session: Session,
  sources: Source<SourceContext, Chunk>[],
  reranker: Reranker,
  opts: RunQueryOpts,
): Operation<QueryResult> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  yield* send({
    type: "plan:start",
    query,
    mode: opts.reasoningMode,
  });

  const plan = yield* runPlanner(query, session, {
    reasoningMode: opts.reasoningMode,
    context: opts.context,
  });

  if (plan.intent === "clarify") {
    return { type: "clarify", plan };
  }

  // Passthrough fast-path. Gated on trunk existence: passthrough forks
  // from the warm spine, so a cold session can't take it. Without trunk
  // we degrade to running the query as a single-task research plan,
  // which transparently gives the user an answer either way.
  if (plan.intent === "passthrough") {
    if (!session.trunk) {
      const fallbackPlan = singleTaskPlan(query);
      opts.onStart?.();
      yield* runResearchPlan(query, fallbackPlan, session, sources, reranker, {
        ...opts,
      });
      return { type: "done" };
    }
    opts.onStart?.();
    const pt = yield* runPassthrough(query, session);
    yield* send({ type: "answer", text: pt.answer });
    yield* finalizePassthrough(plan, pt, opts.wallStartMs);
    return { type: "done" };
  }

  return { type: "research_plan", plan };
}

/**
 * Run a research plan to completion: research pool → (synth iff fan-in)
 * → answer + stats + complete + commitTurn.
 *
 * Used for both:
 *   - accept_plan path: planner-built plan, possibly edited via the
 *     plan-review dialog
 *   - START path: synthetic singleTaskPlan(query) bypassing the planner
 *
 * Synth gate (single conditional, encodes invariant): synth aggregates
 * findings across multiple agents into one argument. tasks.length === 1
 * has nothing to aggregate — the agent's report IS the answer.
 */
export function* runResearchPlan(
  query: string,
  plan: PlanResult,
  session: Session,
  sources: Source<SourceContext, Chunk>[],
  reranker: Reranker,
  opts: RunResearchPlanOpts,
): Operation<void> {
  if (plan.intent !== "research") {
    throw new Error(
      `runResearchPlan: expected plan.intent=research, got ${plan.intent}`,
    );
  }

  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  const tasks = plan.tasks;
  const currentDate = today();

  yield* send({
    type: "research:start",
    agentCount: tasks.length,
    mode: opts.reasoningMode,
  });
  const researchTimer = startTimer();

  for (const source of sources) yield* source.bind({ reranker });
  const scorers = new Map(sources.map((s) => [s, s.createScorer(query)]));
  const allDataTools = sources.flatMap((s) => s.tools);
  const primarySource = sources[0];
  const primaryScorer = scorers.get(primarySource)!;

  const hasWeb = sources.some((s) => s.name === "web");
  const hasCorpus = sources.some(
    (s) =>
      typeof (s as unknown as { promptData?: () => unknown }).promptData ===
      "function",
  );
  const playbooks = renderTemplate(PLAYBOOKS_TEMPLATE, {
    hasWeb,
    hasCorpus,
  });
  const researchTools = [...allDataTools, reportTool];

  let synthTimeMs = 0;
  let researchTimeMs = 0;

  const {
    answer,
    totalTokens: researchTotalTokens,
    totalToolCalls: researchTotalToolCalls,
    synthTokens: synthTotalTokens,
  } = yield* withSpine<{
    answer: string;
    totalTokens: number;
    totalToolCalls: number;
    synthTokens: number;
  }>(
    {
      parent: session.trunk ?? undefined,
      systemPrompt: playbooks,
      tools: researchTools,
    },
    function* (querySpine) {
      if (opts.reasoningMode === "flat") {
        yield* send({ type: "fanout:tasks", tasks });
      }

      const research = yield* agentPool({
        tools: researchTools,
        parent: querySpine,
        terminalToolName: "report",
        maxTurns: opts.maxTurns,
        pruneOnReturn: true,
        policy: createResearchPolicy(),
        scorer: primaryScorer,
        enableThinking: true,
        orchestrate:
          opts.reasoningMode === "flat"
            ? parallel(
                tasks.map((task: ResearchTask, i: number) => ({
                  content: taskToContent(task),
                  systemPrompt: renderWorkerPrompt(primarySource, {
                    maxTurns: opts.maxTurns,
                    agentCount: tasks.length,
                    siblingTasks: tasks
                      .filter((_, j) => j !== i)
                      .map((t) => t.description),
                    date: currentDate,
                    taskIndex: 0,
                  }),
                  seed: 1000 + i,
                })),
              )
            : chain(tasks, (task: ResearchTask, i: number) => ({
                task: {
                  content: taskToContent(task),
                  systemPrompt: renderWorkerPrompt(primarySource, {
                    maxTurns: opts.maxTurns,
                    agentCount: 1,
                    siblingTasks: [],
                    date: currentDate,
                    taskIndex: i,
                  }),
                },
                userContent: `Research task: ${task.description}`,
                beforeSpawn: function* () {
                  yield* send({
                    type: "spine:task",
                    taskIndex: i,
                    taskCount: tasks.length,
                    description: task.description,
                  });
                  yield* send({
                    type: "spine:source",
                    taskIndex: i,
                    source: primarySource.name,
                  });
                },
                afterExtend: function* (delta: number, position: number) {
                  yield* send({
                    type: "spine:task:done",
                    taskIndex: i,
                    stageFindings: delta,
                    accumulated: position,
                  });
                },
              })),
      });

      // Emit research:done HERE — before synth starts — so the flat-mode
      // panel's finalize happens while the cursor is still directly below
      // the panel.
      researchTimeMs = researchTimer();
      yield* send({
        type: "research:done",
        totalTokens: research.totalTokens,
        totalToolCalls: research.totalToolCalls,
        timeMs: researchTimeMs,
      });

      // Synth gate. Synth aggregates fan-in across multiple sources;
      // single-task runs have nothing to aggregate — the agent's
      // report IS the answer. The synth prompts also assume multi-agent
      // framing, so running them on a single source produces awkward
      // output. Skipping saves ~120s of LLM time on START runs.
      if (tasks.length === 1) {
        return {
          answer: research.agents[0]?.result?.trim() ?? "",
          totalTokens: research.totalTokens,
          totalToolCalls: research.totalToolCalls,
          synthTokens: 0,
        };
      }

      yield* send({ type: "synthesize:start" });
      const synthT = startTimer();

      const synthPrompt =
        opts.reasoningMode === "flat" ? SYNTHESIZE_FLAT : SYNTHESIZE_DEEP;
      const findings =
        opts.reasoningMode === "flat"
          ? research.agents
              .map((a, i) => {
                const desc = tasks[i]?.description ?? `task ${i + 1}`;
                const body = a.result?.trim() || "(no findings)";
                return `### Agent ${i + 1}: ${desc}\n\n${body}`;
              })
              .join("\n\n")
          : undefined;
      const synthCtx = {
        query,
        findings,
        agentCount: tasks.length,
      };

      const synth = yield* useAgent({
        systemPrompt: renderTemplate(synthPrompt.system, synthCtx),
        task: renderTemplate(synthPrompt.user, synthCtx),
        parent: querySpine,
        policy: new SynthPolicy(),
        maxTurns: opts.maxTurns,
      });

      synthTimeMs = synthT();
      yield* send({
        type: "synthesize:done",
        agentId: synth.id,
        ppl: synth.branch.disposed ? 0 : synth.branch.perplexity,
        tokenCount: synth.tokenCount,
        toolCallCount: synth.toolCallCount,
        timeMs: synthTimeMs,
      });

      return {
        answer: synth.result || "",
        totalTokens: research.totalTokens,
        totalToolCalls: research.totalToolCalls,
        synthTokens: synth.tokenCount,
      };
    },
  );

  yield* send({ type: "answer", text: answer });
  if (answer) yield* call(() => session.commitTurn(query, answer));

  yield* finalizeResearch({
    plan,
    researchTokens: researchTotalTokens,
    researchToolCalls: researchTotalToolCalls,
    researchTimeMs,
    synthTokens: synthTotalTokens,
    synthTimeMs,
    wallStartMs: opts.wallStartMs,
    send,
  });
}

// ── Finalize helpers ────────────────────────────────────────────

function* finalizePassthrough(
  plan: PlanResult,
  pt: { tokenCount: number; timeMs: number },
  wallStartMs: number,
): Operation<void> {
  const events = yield* Events.expect();
  const send = (ev: StepEvent): Operation<void> =>
    events.send(ev as unknown as AgentEvent);

  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;

  const timings: OpTiming[] = [
    {
      label: "Plan",
      tokens: plan.tokenCount,
      detail: plan.intent,
      timeMs: plan.timeMs,
    },
    {
      label: "Passthrough",
      tokens: pt.tokenCount,
      detail: "trunk stream",
      timeMs: pt.timeMs,
    },
  ];
  yield* send({
    type: "stats",
    timings,
    ctxPct: Math.round((100 * p.cellsUsed) / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });
  yield* send({
    type: "complete",
    data: {
      intent: plan.intent,
      planTokens: plan.tokenCount,
      passthroughTokens: pt.tokenCount,
      wallTimeMs: Math.round(performance.now() - wallStartMs),
      planMs: Math.round(plan.timeMs),
      passthroughMs: Math.round(pt.timeMs),
    },
  });
  // Trunk already contains the streamed user+assistant pair via
  // produceSync+commit; no session.commitTurn needed.
}

function* finalizeResearch(args: {
  plan: PlanResult;
  researchTokens: number;
  researchToolCalls: number;
  researchTimeMs: number;
  synthTokens: number;
  synthTimeMs: number;
  wallStartMs: number;
  send: (ev: StepEvent) => Operation<void>;
}): Operation<void> {
  const ctx: SessionContext = yield* Ctx.expect();
  const p = ctx._storeKvPressure();
  const ctxTotal = p.nCtx || 1;

  const timings: OpTiming[] = [
    {
      label: "Plan",
      tokens: args.plan.tokenCount,
      detail: args.plan.intent,
      timeMs: args.plan.timeMs,
    },
    {
      label: "Research",
      tokens: args.researchTokens,
      detail: `${args.researchToolCalls} tools`,
      timeMs: args.researchTimeMs,
    },
    {
      label: "Synthesize",
      tokens: args.synthTokens,
      detail: args.synthTokens > 0 ? "spine fork" : "skipped (single task)",
      timeMs: args.synthTimeMs,
    },
  ];

  yield* args.send({
    type: "stats",
    timings,
    ctxPct: Math.round((100 * p.cellsUsed) / ctxTotal),
    ctxPos: p.cellsUsed,
    ctxTotal,
  });

  yield* args.send({
    type: "complete",
    data: {
      intent: args.plan.intent,
      planTokens: args.plan.tokenCount,
      agentTokens: args.researchTokens,
      synthTokens: args.synthTokens,
      totalToolCalls: args.researchToolCalls,
      agentCount: args.plan.tasks.length,
      wallTimeMs: Math.round(performance.now() - args.wallStartMs),
      planMs: Math.round(args.plan.timeMs),
      researchMs: Math.round(args.researchTimeMs),
      synthMs: Math.round(args.synthTimeMs),
    },
  });
}
