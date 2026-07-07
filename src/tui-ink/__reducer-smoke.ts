/**
 * Reducer smoke test — drives a synthetic event stream through reduce()
 * and asserts the per-agent timeline shape. Not part of the runtime path.
 *
 *   npx tsx examples/shared/tui-ink/__reducer-smoke.ts
 */

import assert from 'node:assert';
import { reduce } from './reducer';
import { initialState, extractStreamingReport } from './state';
import type { WorkflowEvent } from './events';

function drive(events: WorkflowEvent[]) {
  return events.reduce(reduce, initialState);
}

function check(label: string, fn: () => void) {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n`);
    process.stdout.write(`  ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

check('query → phase=plan', () => {
  const s = drive([{ type: 'query', query: 'hi', warm: false }]);
  assert.equal(s.phase, 'plan');
  assert.equal(s.query, 'hi');
});

check('plan with research intent → phase stays plan', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 't1' }, { description: 't2' }] as never,
      clarifyQuestions: [],
      tokenCount: 42,
      timeMs: 1200,
    },
  ]);
  assert.equal(s.phase, 'plan');
  assert.equal(s.plan?.tasks.length, 2);
});

// ── Plan-edit reducer cases ────────────────────────────────────
function planSeed(): WorkflowEvent[] {
  return [
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [
        { description: 't1' },
        { description: 't2' },
        { description: 't3' },
      ] as never,
      clarifyQuestions: [],
      tokenCount: 42,
      timeMs: 1200,
    },
  ];
}

check('plan:task_updated rewrites the description at the right index', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_updated', index: 1, description: 'new t2' } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks.length, 3);
  assert.equal(s.plan?.tasks[0].description, 't1');
  assert.equal(s.plan?.tasks[1].description, 'new t2');
  assert.equal(s.plan?.tasks[2].description, 't3');
});

check('plan:task_updated out-of-bounds is a no-op', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_updated', index: 99, description: 'ignored' } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks.length, 3);
  assert.equal(s.plan?.tasks[0].description, 't1');
});

check('plan:task_added afterIndex=0 inserts at index 1', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_added', afterIndex: 0 } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks.length, 4);
  assert.equal(s.plan?.tasks[0].description, 't1');
  assert.equal(s.plan?.tasks[1].description, '');
  assert.equal(s.plan?.tasks[2].description, 't2');
});

check('plan:task_added afterIndex=-1 prepends', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_added', afterIndex: -1 } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks.length, 4);
  assert.equal(s.plan?.tasks[0].description, '');
  assert.equal(s.plan?.tasks[1].description, 't1');
});

check('plan:task_deleted removes the indexed task', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_deleted', index: 1 } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks.length, 2);
  assert.equal(s.plan?.tasks[0].description, 't1');
  assert.equal(s.plan?.tasks[1].description, 't3');
});

check('plan:task_deleted is a no-op when only 1 task', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'only one' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'plan:task_deleted', index: 0 } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks.length, 1);
  assert.equal(s.plan?.tasks[0].description, 'only one');
});

check('plan:task_moved swaps the right indices', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_moved', from: 0, to: 2 } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks.length, 3);
  assert.equal(s.plan?.tasks[0].description, 't2');
  assert.equal(s.plan?.tasks[1].description, 't3');
  assert.equal(s.plan?.tasks[2].description, 't1');
});

check('plan:task_moved out-of-bounds to is a no-op', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_moved', from: 0, to: 99 } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks[0].description, 't1');
  assert.equal(s.plan?.tasks[1].description, 't2');
  assert.equal(s.plan?.tasks[2].description, 't3');
});

check('plan:task_moved from === to is a no-op', () => {
  const s = drive([
    ...planSeed(),
    { type: 'plan:task_moved', from: 1, to: 1 } as WorkflowEvent,
  ]);
  assert.equal(s.plan?.tasks[1].description, 't2');
});

check('chain agent:spawn opens a timeline with a live think block', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'first task' }, { description: 'second task' }] as never,
      clarifyQuestions: [],
      tokenCount: 10,
      timeMs: 100,
    },
    { type: 'research:start', agentCount: 2, mode: 'deep' },
    { type: 'spine:task', taskIndex: 0, taskCount: 2, description: 'first task' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.taskIndex, 0);
  assert.equal(a.taskDescription, 'first task');
  assert.equal(a.timeline.length, 1);
  assert.equal(a.timeline[0].kind, 'think');
  assert.equal((a.timeline[0] as { live: boolean }).live, true);
  assert.equal(a.currentThinkId, a.timeline[0].id);
  assert.deepEqual(s.researchAgentIds, [1]);
});

check('flat spawn order assigns taskIndex by spawn count', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [
        { description: 'A' },
        { description: 'B' },
        { description: 'C' },
      ] as never,
      clarifyQuestions: [],
      tokenCount: 10,
      timeMs: 100,
    },
    { type: 'research:start', agentCount: 3, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 2, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 3, parentAgentId: 0 } as WorkflowEvent,
  ]);
  assert.deepEqual(s.researchAgentIds, [1, 2, 3]);
  assert.deepEqual([
    s.agents.get(1)?.taskIndex,
    s.agents.get(2)?.taskIndex,
    s.agents.get(3)?.taskIndex,
  ], [0, 1, 2]);
  assert.deepEqual([
    s.agents.get(1)?.taskDescription,
    s.agents.get(2)?.taskDescription,
    s.agents.get(3)?.taskDescription,
  ], ['A', 'B', 'C']);
});

check('produce accumulates into the live think item', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'Hello ', tokenCount: 1 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'world', tokenCount: 2 } as WorkflowEvent,
  ]);
  const think = s.agents.get(1)!.timeline[0] as { body: string; live: boolean };
  assert.equal(think.body, 'Hello world');
  assert.equal(think.live, true);
});

check('</think> closes the think and transitions agent to content', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'Think header\nmore body', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: '</think>\n\nprose', tokenCount: 4 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const think = a.timeline[0] as { body: string; live: boolean; title: string };
  assert.equal(think.live, false);
  assert.equal(think.body, 'Think header\nmore body');
  assert.equal(think.title, 'Think header');
  assert.equal(a.phase, 'content');
  assert.equal(a.currentThinkId, null);
});

check('tool_call appends a tool_call item and force-closes live think', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'partial', tokenCount: 3 } as WorkflowEvent,
    {
      type: 'agent:tool_call',
      agentId: 1,
      tool: 'web_search',
      args: '{"query":"voice latency"}',
    } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.timeline.length, 2);
  assert.equal(a.timeline[0].kind, 'think');
  assert.equal((a.timeline[0] as { live: boolean }).live, false);
  assert.equal(a.timeline[1].kind, 'tool_call');
  assert.equal((a.timeline[1] as { tool: string }).tool, 'web_search');
  assert.equal((a.timeline[1] as { argsSummary: string }).argsSummary, '"voice latency"');
  assert.equal(a.phase, 'tool');
  assert.equal(a.pendingToolCallId, a.timeline[1].id);
});

check('tool_result pairs with last tool_call and increments sourceCount', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:tool_call', agentId: 1, tool: 'web_search', args: '{}' } as WorkflowEvent,
    {
      type: 'agent:tool_result',
      agentId: 1,
      tool: 'web_search',
      result: JSON.stringify([
        { url: 'https://livekit.io/voice', title: 'Voice agent' },
        { url: 'https://telnyx.com/ai', title: 'Telnyx AI' },
        { url: 'https://livekit.io/voice-2', title: 'Voice 2' },
      ]),
    } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const tr = a.timeline[a.timeline.length - 1] as {
    kind: string;
    hosts: string[];
    resultCount: number;
    callId: number;
  };
  assert.equal(tr.kind, 'tool_result');
  assert.deepEqual(tr.hosts.sort(), ['livekit.io', 'telnyx.com']);
  assert.equal(tr.resultCount, 3);
  assert.equal(tr.callId, a.timeline[1].id);
  assert.equal(s.sourceCount, 2);
  assert.equal(a.phase, 'idle');
});

check('re-enter thinking after tool_result opens a new think item', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'first</think>', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:tool_call', agentId: 1, tool: 'web_search', args: '{}' } as WorkflowEvent,
    { type: 'agent:tool_result', agentId: 1, tool: 'web_search', result: '[]' } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'second', tokenCount: 4 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const thinks = a.timeline.filter((it) => it.kind === 'think');
  assert.equal(thinks.length, 2);
  assert.equal((thinks[0] as { live: boolean }).live, false);
  assert.equal((thinks[0] as { body: string }).body, 'first');
  assert.equal((thinks[1] as { live: boolean }).live, true);
  assert.equal((thinks[1] as { body: string }).body, 'second');
});

check('report item pushed at agent:report', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'done thinking</think>', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:return', agentId: 1, result: 'Final findings paragraph.' } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const last = a.timeline[a.timeline.length - 1];
  assert.equal(last.kind, 'report');
  assert.equal((last as { body: string }).body, 'Final findings paragraph.');
  assert.equal(a.phase, 'done');
});

check('synth spawn/produce routes into synth.buffer, not an agent timeline', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'research:done', totalTokens: 100, totalToolCalls: 3, timeMs: 2000 },
    { type: 'synthesize:start' },
    { type: 'agent:spawn', agentId: 7, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 7, text: 'The answer is ', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 7, text: 'X.', tokenCount: 5 } as WorkflowEvent,
  ]);
  assert.equal(s.synth.buffer, 'The answer is X.');
  assert.equal(s.agents.get(7)?.timeline.length, 0);
  assert.deepEqual(s.researchAgentIds, []);
});

check('chain dependencyHint set for taskIndex > 0', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'first' }, { description: 'second' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 2, mode: 'deep' },
    { type: 'spine:task', taskIndex: 0, taskCount: 2, description: 'first' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'spine:task', taskIndex: 1, taskCount: 2, description: 'second' },
    { type: 'agent:spawn', agentId: 2, parentAgentId: 0 } as WorkflowEvent,
  ]);
  assert.equal(s.agents.get(1)?.dependencyHint, null);
  assert.equal(s.agents.get(2)?.dependencyHint, 'builds on Task 1');
});

check('post-</think> tokens stream into contentBuffer, cleared by tool_call', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'thinking</think>\n\n<tool_call>', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'web_search({"query":"x"})', tokenCount: 4 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.phase, 'content');
  assert.equal(a.contentBuffer.startsWith('\n\n<tool_call>'), true);
  assert.match(a.contentBuffer, /web_search/);

  const s2 = reduce(s, {
    type: 'agent:tool_call',
    agentId: 1,
    tool: 'web_search',
    args: '{"query":"x"}',
  } as WorkflowEvent);
  assert.equal(s2.agents.get(1)?.contentBuffer, '');
  assert.equal(s2.agents.get(1)?.phase, 'tool');
});

check('report path: content streams, then report event clears buffer + pushes structured item', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'decided to report</think>\n\n', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: '<tool_call>\n{"name":"report","arguments":{"result":"The final ', tokenCount: 4 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'answer is X."}}\n</tool_call>', tokenCount: 5 } as WorkflowEvent,
  ]);
  const mid = s.agents.get(1)!;
  assert.ok(mid.contentBuffer.length > 10, 'buffer accumulated');
  assert.match(mid.contentBuffer, /The final/);

  const s2 = reduce(s, {
    type: 'agent:return',
    agentId: 1,
    result: 'The final answer is X.',
  } as WorkflowEvent);
  const a = s2.agents.get(1)!;
  assert.equal(a.contentBuffer, '');
  assert.equal(a.phase, 'done');
  const last = a.timeline[a.timeline.length - 1];
  assert.equal(last.kind, 'report');
  assert.equal((last as { body: string }).body, 'The final answer is X.');
});

// ── Live terminal-report streaming (marker-based, off the raw agent:produce
// ── stream — same technique the think block uses with </think>) ────────
function reportStreamSeed(): WorkflowEvent[] {
  return [
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
  ];
}

check('terminal report streams into contentBuffer as raw post-think tokens', () => {
  // The model emits the terminal call as Hermes XML. After </think> closes,
  // the raw tokens (incl. the report body inside <parameter=result>) flow into
  // contentBuffer. (The desktop renderer's extractStreamingReport reads this
  // buffer; the reducer contract is just: buffer accumulates, phase 'content'.)
  const s = drive([
    ...reportStreamSeed(),
    {
      type: 'agent:produce',
      agentId: 1,
      text: 'decided to report</think>\n\n<tool_call>\n<function=report>\n<parameter=result>\n**Partial report',
      tokenCount: 3,
    } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: ' — findings so far', tokenCount: 4 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.phase, 'content');
  // Raw buffer holds the post-</think> XML, marker and all.
  assert.match(a.contentBuffer, /<parameter=result>/);
  assert.match(a.contentBuffer, /\*\*Partial report — findings so far/);
});

check('terminal report agent:tool_call pushes NO generic "Reading" timeline row', () => {
  // The report already streamed live via contentBuffer; the terminal
  // agent:tool_call at the stop token must NOT add a generic tool_call row
  // (which WorkRows would label "Reading"). agent:return finalizes the report.
  const s = drive([
    ...reportStreamSeed(),
    {
      type: 'agent:produce',
      agentId: 1,
      text: 'go</think>\n\n<tool_call>\n<function=report>\n<parameter=result>\n**Report body',
      tokenCount: 3,
    } as WorkflowEvent,
    { type: 'agent:tool_call', agentId: 1, tool: 'report', args: '{"result":"**Report body"}' } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  // No tool_call row at all — only the (closed) think item is on the timeline.
  assert.equal(a.timeline.filter((it) => it.kind === 'tool_call').length, 0);
  assert.equal(a.phase, 'tool');
  // contentBuffer cleared by the terminal tool_call (the live row is done; the
  // structured report item lands on agent:return).
  assert.equal(a.contentBuffer, '');

  // agent:return then freezes the engine-parsed final body into a report item.
  const s2 = reduce(s, { type: 'agent:return', agentId: 1, result: '**Report body**' } as WorkflowEvent);
  const a2 = s2.agents.get(1)!;
  assert.equal(a2.phase, 'done');
  const last = a2.timeline[a2.timeline.length - 1];
  assert.equal(last.kind, 'report');
  assert.equal((last as { body: string }).body, '**Report body**');
});

check('non-terminal web_search tool_call/result still produces a paired "Searched ✓" row (no regression)', () => {
  const s = drive([
    ...reportStreamSeed(),
    { type: 'agent:produce', agentId: 1, text: 'planning</think>', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:tool_call', agentId: 1, tool: 'web_search', args: '{"query":"voice latency"}' } as WorkflowEvent,
    {
      type: 'agent:tool_result',
      agentId: 1,
      tool: 'web_search',
      result: JSON.stringify([{ url: 'https://livekit.io/voice', title: 'Voice agent' }]),
    } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const call = a.timeline.find((it) => it.kind === 'tool_call') as { id: number; tool: string } | undefined;
  const result = a.timeline.find((it) => it.kind === 'tool_result') as { callId: number; tool: string } | undefined;
  assert.ok(call, 'web_search tool_call row present (not suppressed)');
  assert.equal(call!.tool, 'web_search');
  assert.ok(result, 'tool_result row present');
  // Pairs with its call (WorkRows renders the verb + ✓ meta on one row → "Searched ✓").
  assert.equal(result!.callId, call!.id);
});

check('agent:done marks recovering; the recovery stream routes to contentBuffer (not a think block)', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'unfinished thought', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:done', agentId: 1 } as WorkflowEvent,
    // recoverInline force-extracts the report (eager grammar, no </think>).
    { type: 'agent:produce', agentId: 1, text: 'recovery output', tokenCount: 5 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  // The ORIGINAL think closed on agent:done; recovery does NOT open a new one —
  // it streams into contentBuffer (rendered as "Writing report"), not "Thinking".
  const thinks = a.timeline.filter((it) => it.kind === 'think');
  assert.equal(thinks.length, 1);
  assert.equal((thinks[0] as { live: boolean; body: string }).live, false);
  assert.equal((thinks[0] as { body: string }).body, 'unfinished thought');
  assert.equal(a.recovering, true);
  assert.equal(a.contentBuffer, 'recovery output');
  assert.equal(a.phase, 'idle');
});

check('agent:recovered clears recovering + contentBuffer and freezes the report', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:done', agentId: 1 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: '{"result":"X"}', tokenCount: 5 } as WorkflowEvent,
    { type: 'agent:recovered', agentId: 1, result: 'X' } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.recovering, false);
  assert.equal(a.contentBuffer, '');
  assert.equal(a.phase, 'done');
  const reports = a.timeline.filter((it) => it.kind === 'report');
  assert.equal(reports.length, 1);
  assert.equal((reports[0] as { body: string }).body, 'X');
});

check('agent:failed marks the agent terminally failed (cross), freezes the timer, no report', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:done', agentId: 1 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: '{"result":"half a repo', tokenCount: 5 } as WorkflowEvent,
    { type: 'agent:failed', agentId: 1, reason: 'scope_error: BranchStore::decode_each - llama_decode failed' } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.phase, 'failed');                       // terminal → cross, not a spinner
  assert.equal(a.recovering, false);                     // stops the "Writing report" row
  assert.equal(a.contentBuffer, '');                     // partial report dropped, not promoted
  assert.notEqual(a.endedAt, null);                      // elapsed timer frozen
  assert.match(a.failReason ?? '', /llama_decode failed/); // surfaced for the tooltip
  assert.equal(a.timeline.filter((it) => it.kind === 'report').length, 0); // no report
  assert.equal(s.researchAgentIds.includes(1), false);   // dropped from the live tree
});

check('config:loaded seeds config without forcing a uiPhase transition', () => {
  const s = drive([
    {
      type: 'config:loaded',
      config: {
        version: 1,
        sources: {},
        apps: { web: { tavilyKey: 'tvly-x' } },
        defaults: { reasoningMode: 'deep', effort: 'high', maxTurns: 10 },
        model: {},
      },
      origin: {
        reasoningMode: 'file',
        modelPath: 'default',
        reranker: 'default',
        nCtx: 'default',
        gpu: 'default',
        outputDir: 'default',
      },
      path: '/tmp/harness.json',
    } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'boot');
  assert.equal(s.config?.apps.web.tavilyKey, 'tvly-x');
  assert.equal(s.configOrigin?.reasoningMode, 'file');
});

check('download:plan populates downloads + uiPhase=downloading', () => {
  const s = drive([
    {
      type: 'download:plan',
      entries: [{ id: 'llm', label: 'LLM', sizeBytes: 1000 }],
    } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'downloading');
  assert.equal(s.downloads.length, 1);
  assert.equal(s.downloads[0].id, 'llm');
  assert.equal(s.downloads[0].started, false);
  assert.equal(s.downloads[0].done, false);
});

check('download:start marks the planned entry started (no append)', () => {
  const s = drive([
    {
      type: 'download:plan',
      entries: [{ id: 'llm', label: 'LLM', sizeBytes: 1000 }],
    } as WorkflowEvent,
    { type: 'download:start', id: 'llm', label: 'LLM', sizeBytes: 1000 } as WorkflowEvent,
  ]);
  assert.equal(s.downloads.length, 1);
  assert.equal(s.downloads[0].started, true);
});

check('download:start without prior plan is dropped (no duplicate entry)', () => {
  const s = drive([
    { type: 'download:start', id: 'orphan', label: 'X', sizeBytes: 100 } as WorkflowEvent,
  ]);
  // uiPhase still flips, but no entry is appended — plan is the only path
  // that grows downloads. Prevents id-collision bugs from accidental dupes.
  assert.equal(s.uiPhase, 'downloading');
  assert.equal(s.downloads.length, 0);
});

check('download:progress updates got/total for the matching id', () => {
  const s = drive([
    {
      type: 'download:plan',
      entries: [
        { id: 'a', label: 'A', sizeBytes: 100 },
        { id: 'b', label: 'B', sizeBytes: 200 },
      ],
    } as WorkflowEvent,
    { type: 'download:start', id: 'a', label: 'A', sizeBytes: 100 } as WorkflowEvent,
    { type: 'download:progress', id: 'a', got: 50, total: 100 } as WorkflowEvent,
  ]);
  const a = s.downloads.find((d) => d.id === 'a')!;
  const b = s.downloads.find((d) => d.id === 'b')!;
  assert.equal(a.got, 50);
  assert.equal(b.got, 0);
});

check('download:progress carries url through to state', () => {
  const s = drive([
    {
      type: 'download:plan',
      entries: [{ id: 'llm', label: 'LLM', sizeBytes: 100 }],
    } as WorkflowEvent,
    {
      type: 'download:progress',
      id: 'llm',
      got: 50,
      total: 100,
      url: 'https://huggingface.co/x/y',
    } as WorkflowEvent,
  ]);
  assert.equal(s.downloads[0].url, 'https://huggingface.co/x/y');
});

check('download:complete marks entry done', () => {
  const s = drive([
    {
      type: 'download:plan',
      entries: [{ id: 'llm', label: 'LLM', sizeBytes: 100 }],
    } as WorkflowEvent,
    { type: 'download:start', id: 'llm', label: 'LLM', sizeBytes: 100 } as WorkflowEvent,
    { type: 'download:complete', id: 'llm' } as WorkflowEvent,
  ]);
  assert.equal(s.downloads[0].done, true);
  // uiPhase stays 'downloading' — main.ts explicitly transitions to 'loading'
  assert.equal(s.uiPhase, 'downloading');
});

check('weights:start → uiPhase=loading + loadingLabel set', () => {
  const s = drive([
    { type: 'weights:start', label: 'Loading Qwen3.5-4B…' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'loading');
  assert.equal(s.loadingLabel, 'Loading Qwen3.5-4B…');
});

check('weights:label updates the label in place', () => {
  const s = drive([
    { type: 'weights:start', label: 'a' } as WorkflowEvent,
    { type: 'weights:label', label: 'b' } as WorkflowEvent,
  ]);
  assert.equal(s.loadingLabel, 'b');
});

check('weights:done clears loadingLabel', () => {
  const s = drive([
    { type: 'weights:start', label: 'a' } as WorkflowEvent,
    { type: 'weights:done' } as WorkflowEvent,
  ]);
  assert.equal(s.loadingLabel, null);
});

check('plan:start → uiPhase=planning', () => {
  const s = drive([
    { type: 'plan:start', query: 'hi', mode: 'deep' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'planning');
  assert.equal(s.query, 'hi');
});

check('ui:plan_review → uiPhase=plan_review', () => {
  const s = drive([
    { type: 'plan:start', query: 'hi', mode: 'deep' } as WorkflowEvent,
    { type: 'ui:plan_review' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'plan_review');
});

check('research:start → uiPhase=research; complete → uiPhase=done', () => {
  const s = drive([
    { type: 'research:start', agentCount: 1, mode: 'deep' },
    { type: 'complete', data: {} },
  ]);
  assert.equal(s.uiPhase, 'done');
});

check('ui:composer with prefill sets composerPrefill', () => {
  const s = drive([
    { type: 'ui:composer', prefill: 'last query' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'composer');
  assert.equal(s.composerPrefill, 'last query');
});

check('config:updated produces a toast; skipped fields flagged', () => {
  const cfg = {
    version: 1 as const,
    sources: {},
    apps: { corpus: { corpusPath: '/tmp/c' } },
    defaults: { reasoningMode: 'deep' as const, effort: 'high' as const, maxTurns: 10 },
    model: {},
  };
  const origin = {
    reasoningMode: 'file' as const,
    modelPath: 'default' as const,
    reranker: 'default' as const,
    nCtx: 'default' as const,
    gpu: 'default' as const,
    outputDir: 'default' as const,
  };
  const s = drive([
    {
      type: 'config:updated',
      config: cfg,
      origin,
      savedTo: '/tmp/harness.json',
      gitignored: true,
      skipped: [],
    } as WorkflowEvent,
  ]);
  assert.ok(s.toast);
  assert.match(s.toast!.message, /added to \.gitignore/);
  assert.equal(s.toast!.tone, 'success');

  const s2 = drive([
    {
      type: 'config:updated',
      config: cfg,
      origin,
      savedTo: '/tmp/harness.json',
      gitignored: false,
      skipped: ['sources.tavilyKey'],
    } as WorkflowEvent,
  ]);
  assert.match(s2.toast!.message, /env active/);
  assert.equal(s2.toast!.tone, 'warn');
});

check('mode survives a re-plan round trip (plan:start → query → plan → ui:plan_review)', () => {
  // Simulates pressing T in PlanReview: main sends plan:start with the new
  // mode, runPlanner emits query then plan, main sends ui:plan_review. The
  // query event must preserve mode so PlanReview's useState initializer
  // sees the new choice on remount.
  const s = drive([
    { type: 'plan:start', query: 'q', mode: 'flat' } as WorkflowEvent,
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 10,
      timeMs: 100,
    },
    { type: 'ui:plan_review' } as WorkflowEvent,
  ]);
  assert.equal(s.mode, 'flat');
  assert.equal(s.uiPhase, 'plan_review');
});

check('pipeline timer: plan:start starts, plan_review pauses, research:start resumes, complete freezes', () => {
  let s = reduce(initialState, { type: 'ui:composer' } as WorkflowEvent);
  assert.equal(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, 0);

  // Fresh submission from composer — starts timer from zero.
  s = reduce(s, { type: 'plan:start', query: 'q', mode: 'deep' } as WorkflowEvent);
  assert.notEqual(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, 0);

  // Plan review → timer pauses, banking whatever ran.
  s = reduce(s, { type: 'ui:plan_review' } as WorkflowEvent);
  assert.equal(s.pipelineResumedAt, null);
  assert.ok(s.pipelineElapsedMs >= 0);
  const pauseSnapshot = s.pipelineElapsedMs;

  // Research accept → timer resumes with accumulator preserved.
  s = reduce(s, { type: 'research:start', agentCount: 1, mode: 'deep' });
  assert.notEqual(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, pauseSnapshot);

  // Complete → freezes accumulator, clears resume.
  s = reduce(s, { type: 'complete', data: {} });
  assert.equal(s.pipelineResumedAt, null);
  assert.ok(s.pipelineElapsedMs >= pauseSnapshot);
});

check('pipeline timer: re-plan from plan_review keeps accumulator', () => {
  let s = reduce(initialState, { type: 'ui:composer' } as WorkflowEvent);
  s = reduce(s, { type: 'plan:start', query: 'q', mode: 'deep' } as WorkflowEvent);
  s = reduce(s, { type: 'ui:plan_review' } as WorkflowEvent);
  const afterFirstPlan = s.pipelineElapsedMs;
  // User presses T → main emits plan:start again with new mode.
  s = reduce(s, { type: 'plan:start', query: 'q', mode: 'flat' } as WorkflowEvent);
  // Still running — accumulator preserved (no reset on re-plan).
  assert.notEqual(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, afterFirstPlan);
});

check('ui:error drops to composer with error toast', () => {
  const s = drive([
    { type: 'plan:start', query: 'x', mode: 'deep' } as WorkflowEvent,
    { type: 'ui:error', message: 'planner failed' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'composer');
  assert.match(s.toast!.message, /planner failed/);
  assert.equal(s.toast!.tone, 'error');
});

check('agent:tick updates pressure', () => {
  const s = drive([
    { type: 'agent:tick', cellsUsed: 4000, nCtx: 16384 } as WorkflowEvent,
  ]);
  assert.equal(s.pressure?.pct, 24);
});

// ── Pre-flight recon cases ─────────────────────────────────────

check('preflight:start → uiPhase=discovering, phase=recon', () => {
  const s = drive([
    { type: 'ui:composer' } as WorkflowEvent,
    { type: 'preflight:start', query: 'firefox apis', appCount: 2 } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'discovering');
  assert.equal(s.phase, 'recon');
  assert.equal(s.query, 'firefox apis');
  assert.deepEqual(s.reconAgentIds, []);
});

check('recon agent streams via reconAgentIds, never researchAgentIds', () => {
  const s = drive([
    { type: 'preflight:start', query: 'q', appCount: 2 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'probing</think>', tokenCount: 2 } as WorkflowEvent,
    { type: 'agent:tool_call', agentId: 1, tool: 'search', args: '{"query":"firefox"}' } as WorkflowEvent,
    { type: 'agent:tool_result', agentId: 1, tool: 'search', result: '[]' } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.deepEqual(s.reconAgentIds, [1]);
  assert.deepEqual(s.researchAgentIds, []);
  assert.equal(a.taskIndex, 0);
  // think + tool_call + tool_result on the timeline (live stream, not muted).
  assert.equal(a.timeline.filter((it) => it.kind === 'tool_call').length, 1);
  assert.equal(a.timeline.filter((it) => it.kind === 'tool_result').length, 1);
});

check('recon agent:return reports without freezing into research scrollback', () => {
  const s = drive([
    { type: 'preflight:start', query: 'q', appCount: 2 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'done</think>', tokenCount: 2 } as WorkflowEvent,
    { type: 'agent:return', agentId: 1, result: 'corpus_research: HDK; web_research: firefox' } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.phase, 'done');
  assert.equal(a.timeline[a.timeline.length - 1].kind, 'report');
  // Recon is throwaway — not pushed to scrollback (that's research-only).
  assert.equal(s.scrollback.length, 0);
  assert.deepEqual(s.reconAgentIds, [1]);
});

check('discovering → planning hand-off: query event clears recon agents', () => {
  const s = drive([
    { type: 'preflight:start', query: 'q', appCount: 2 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'preflight:done', coverage: 'x', tokens: 10, toolCalls: 2, timeMs: 500 } as WorkflowEvent,
    { type: 'plan:start', query: 'q', mode: 'deep' } as WorkflowEvent,
    { type: 'query', query: 'q', warm: false },
  ]);
  // preflight:done is bracket-only; plan:start flips to planning; query resets.
  assert.equal(s.uiPhase, 'planning');
  assert.equal(s.phase, 'plan');
  assert.deepEqual(s.reconAgentIds, []);
  assert.equal(s.agents.size, 0);
});

// ── Stop escape hatch ──────────────────────────────────────────
// `stop` halts the run fiber engine-side and emits `ui:composer`. From the
// renderer's view only `ui:composer` arrives, so this guards the reducer
// invariant Stop relies on: ui:composer resets ONLY the phase, never the
// streamed transcript (frozen agent panels in scrollback + the live synth
// buffer + agent timelines all survive the return-to-composer).
check('stop → ui:composer returns to composer, RETAINS scrollback + synth buffer + agents', () => {
  const mid = drive([
    { type: 'plan:start', query: 'q', mode: 'flat' } as WorkflowEvent,
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 't1' }] as never,
      clarifyQuestions: [],
      tokenCount: 10,
      timeMs: 100,
    },
    // research:start sets phase=research so the spawned agent is a research
    // agent and agent:return freezes its panel into scrollback.
    { type: 'research:start', agentCount: 1, mode: 'flat' } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'finding</think>', tokenCount: 2 } as WorkflowEvent,
    { type: 'agent:return', agentId: 1, result: '## A0 report' } as WorkflowEvent,
    // Synth starts and streams a partial body, then the user STOPS — no
    // synthesize:done arrives.
    { type: 'synthesize:start' } as WorkflowEvent,
    { type: 'agent:produce', agentId: 2, text: 'partial answer so far', tokenCount: 4 } as WorkflowEvent,
  ]);
  // Pre-stop snapshot: A0 frozen in scrollback, synth has a live partial.
  assert.equal(mid.uiPhase, 'research');
  assert.ok(mid.scrollback.length >= 1, 'expected the A0 agent panel in scrollback pre-stop');
  assert.equal(mid.scrollback[0].kind, 'agent');
  assert.ok(mid.synth.buffer.length > 0, 'expected a live synth buffer pre-stop');
  const scrollbackBefore = mid.scrollback.length;
  const synthBufBefore = mid.synth.buffer;
  const agentsBefore = mid.agents.size;

  // Stop → engine sends ui:composer.
  const after = reduce(mid, { type: 'ui:composer' });
  assert.equal(after.uiPhase, 'composer', 'ui:composer must reset uiPhase to composer');
  assert.equal(after.scrollback.length, scrollbackBefore, 'stop must NOT clear scrollback');
  assert.equal(after.synth.buffer, synthBufBefore, 'stop must NOT clear the synth buffer');
  assert.equal(after.agents.size, agentsBefore, 'stop must NOT clear agent timelines');
  assert.equal(after.query, 'q', 'prior query text survives for follow-up context');
});

check('extractStreamingReport: marker-gated report body from Hermes buffer', () => {
  // No open marker yet → null (keeps non-terminal tool args off-screen).
  assert.equal(extractStreamingReport('<tool_call>\n<function=web_search>\n<parameter=query>voice latency'), null);
  assert.equal(extractStreamingReport(''), null);
  // Open marker arrived → body streams from there (leading newline dropped).
  assert.equal(
    extractStreamingReport('<tool_call>\n<function=report>\n<parameter=result>\n## Findings\nStreaming body'),
    '## Findings\nStreaming body',
  );
  // Close marker arrived → body truncates at it.
  assert.equal(
    extractStreamingReport('junk<parameter=result>\nDone body\n</parameter>\n</function>'),
    'Done body\n',
  );
  // The recovering branch (raw buffer, no envelope) is caller-side — the
  // renderer bypasses extraction entirely when agent.recovering is true.
});

check('backendpack:offer → dialog phase; plan/weights exit it', () => {
  const offer = {
    type: 'backendpack:offer' as const,
    gpuName: 'NVIDIA H100 80GB HBM3',
    sizeBytes: 800_000_000,
    needsRuntime: true,
    runtimeSizeBytes: 250_000_000,
    reasons: ['native sm_90 SASS in pack', 'runtime 12.2 < required 12.9'],
  };
  const offered = reduce(initialState, offer);
  assert.equal(offered.uiPhase, 'backend_pack_offer');
  assert.equal(offered.backendPackOffer?.gpuName, 'NVIDIA H100 80GB HBM3');
  assert.equal(offered.backendPackOffer?.needsRuntime, true);

  // Accept path: download:plan takes over the screen and clears the payload.
  const accepted = reduce(offered, {
    type: 'download:plan',
    entries: [{ id: 'backend-pack', label: 'CUDA backend pack', sizeBytes: 800_000_000 }],
  });
  assert.equal(accepted.uiPhase, 'downloading');
  assert.equal(accepted.backendPackOffer, null);

  // Decline path: boot proceeds straight to the load phase.
  const declined = reduce(offered, { type: 'weights:start', label: 'Loading…' });
  assert.equal(declined.uiPhase, 'loading');
  assert.equal(declined.backendPackOffer, null);
});

process.stdout.write('---\n');
process.stdout.write(process.exitCode ? 'FAILED\n' : 'all passed\n');
