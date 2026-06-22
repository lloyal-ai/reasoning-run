/**
 * Event union consumed by the Ink reducer.
 *
 * These mirror the StepEvent variants emitted by examples/deep-research/harness.ts
 * (formerly in examples/deep-research/tui.ts) plus the AgentEvent stream coming
 * from @lloyal-labs/lloyal-agents. The harness continues to emit the same events
 * — only the rendering layer is replaced.
 */

import type { AgentEvent } from '@lloyal-labs/lloyal-agents';
import type { PlanIntent, ResearchTask } from '@lloyal-labs/rig';
import type { OpTiming } from './state';
import type { EnvMeta } from './state';
import type { Config, ConfigOrigin } from './config';

export type StepEvent =
  | { type: 'query'; query: string; warm: boolean }
  | {
      type: 'plan';
      intent: PlanIntent;
      tasks: ResearchTask[];
      clarifyQuestions: string[];
      tokenCount: number;
      timeMs: number;
    }
  | { type: 'research:start'; agentCount: number; mode: 'flat' | 'deep' }
  | { type: 'research:done'; totalTokens: number; totalToolCalls: number; timeMs: number }
  | { type: 'fanout:tasks'; tasks: ResearchTask[] }
  | { type: 'spine:task'; taskIndex: number; taskCount: number; description: string }
  | { type: 'spine:source'; taskIndex: number; source: string }
  | { type: 'spine:task:done'; taskIndex: number; stageFindings: number; accumulated: number }
  | { type: 'synthesize:start' }
  | {
      type: 'synthesize:done';
      agentId: number;
      ppl: number;
      tokenCount: number;
      toolCallCount: number;
      timeMs: number;
    }
  | { type: 'answer'; text: string }
  | {
      type: 'stats';
      timings: OpTiming[];
      kvLine?: string;
      ctxPct: number;
      ctxPos: number;
      ctxTotal: number;
    }
  | { type: 'complete'; data: Record<string, unknown> }
  // ── UI / config events driven by main.ts ────────────────────────
  | { type: 'config:loaded'; config: Config; origin: ConfigOrigin; path: string }
  | {
      type: 'config:updated';
      config: Config;
      origin: ConfigOrigin;
      savedTo: string;
      gitignored: boolean;
      skipped: string[];
    }
  // ── Pre-flight recon (RFC: multi-app composition) — a recon agent probes
  // ── each source for the query's entities BEFORE planning to ground routing.
  // ── Its probe calls also stream as agent:* events (rendered live), so these
  // ── two only bracket the phase; the per-probe detail is the agent stream.
  | { type: 'preflight:start'; query: string; appCount: number }
  | {
      type: 'preflight:done';
      coverage: string;
      tokens: number;
      toolCalls: number;
      timeMs: number;
    }
  | { type: 'plan:start'; query: string; mode: 'flat' | 'deep' }
  // ── Plan-edit events: user-driven mutations of state.plan.tasks before
  // ── accept_plan. afterIndex: -1 means prepend; out-of-bounds indices
  // ── on the others are reducer no-ops (defensive).
  | { type: 'plan:task_updated'; index: number; description: string }
  | { type: 'plan:task_added'; afterIndex: number }
  | { type: 'plan:task_deleted'; index: number }
  | { type: 'plan:task_moved'; from: number; to: number }
  | { type: 'ui:composer'; prefill?: string }
  | { type: 'ui:plan_review' }
  | { type: 'ui:error'; message: string }
  | { type: 'ui:env'; env: EnvMeta }
  // ── Boot-phase events: download progress + weight-loading spinner ──
  /** Pre-populates `state.downloads` with the full set of files about to
   *  be fetched. Sent ONCE before any individual download:start so the
   *  dynamic tree size is fixed from the moment 'downloading' begins. */
  | { type: 'download:plan'; entries: { id: string; label: string; sizeBytes: number }[] }
  | { type: 'download:start'; id: string; label: string; sizeBytes: number }
  | { type: 'download:progress'; id: string; got: number; total: number; url?: string }
  | { type: 'download:complete'; id: string }
  | { type: 'weights:start'; label: string }
  | { type: 'weights:label'; label: string }
  | { type: 'weights:done' }
  | { type: 'corpus:indexed'; corpusPath: string; fileCount: number; chunkCount: number }
  | { type: 'boot:error'; kind: 'llm' | 'reranker'; message: string }
  // Per-query App participation toggle. Emitted by main.ts in response to
  // a `toggle_participation` Command from the Composer. The reducer flips
  // the bit in `state.participation[name]`. Pure UI state — no harness
  // side effects; main.ts derives `appFilter` from `state.participation`
  // at submit time and threads it into runQuery / runResearchPlan.
  | { type: 'participation:toggled'; name: string };

export type WorkflowEvent = AgentEvent | StepEvent;
