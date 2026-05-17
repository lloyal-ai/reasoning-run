/**
 * Smoke tests for RunDirSink — synthesizes a fake event stream and asserts
 * that report.md + annexure-N.md are written with expected content.
 *
 *   npx tsx src/__rundir-smoke.ts
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunDirSink } from './run-dir';
import type { WorkflowEvent } from './tui-ink/events';

function check(label: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n`);
    throw err;
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundir-smoke-'));

/** Each test gets its own outputDir subdir so RunDirSink.start's
 *  millisecond-resolution timestamps can't collide across rapid-fire test
 *  invocations and reuse a directory from a prior test. */
let testIdx = 0;
function freshOutputDir(): string {
  const dir = path.join(tmpRoot, `t${testIdx++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Helper: drive a stream and return the run-dir ──────────────────
function drive(events: WorkflowEvent[]): string {
  const sink = new RunDirSink();
  const dir = sink.start({
    outputDir: freshOutputDir(),
    query: 'How do voice agents hit sub-800ms latency on-device?',
    mode: 'flat',
  });
  for (const ev of events) sink.handle(ev);
  return dir;
}

// ── flat-mode 3-agent run produces report + 3 annexures ────────────
check('flat-mode: writes report.md + annexure-{1,2,3}.md', () => {
  const dir = drive([
    { type: 'research:start', agentCount: 3, mode: 'flat' },
    {
      type: 'fanout:tasks',
      tasks: [
        { description: 'Survey STT models and their latency profiles' },
        { description: 'Compare local LLM inference engines' },
        { description: 'Survey TTS models with expressive output' },
      ] as never,
    },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 2, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 3, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:return', agentId: 1, result: 'STT findings: Whisper INT4 hits ~120ms.' } as WorkflowEvent,
    { type: 'agent:return', agentId: 2, result: 'LLM findings: Phi-3 4-bit at ~80ms/tok.' } as WorkflowEvent,
    { type: 'agent:return', agentId: 3, result: 'TTS findings: StyleTTS2 at ~90ms.' } as WorkflowEvent,
    { type: 'research:done', totalTokens: 400, totalToolCalls: 12, timeMs: 4000 },
    { type: 'synthesize:start' },
    {
      type: 'synthesize:done',
      agentId: 10,
      ppl: 2.6,
      tokenCount: 600,
      toolCallCount: 1,
      timeMs: 2000,
    },
    { type: 'answer', text: 'Voice agents stream STT, LLM, TTS overlapping for sub-800ms round-trip.' },
    { type: 'complete', data: {} },
  ]);

  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(report, /# How do voice agents/);
  assert.match(report, /Voice agents stream STT/);
  assert.match(report, /Annexures/);
  assert.match(report, /\[Annexure 1\]\(\.\/annexure-1\.md\)/);
  assert.match(report, /\[Annexure 2\]\(\.\/annexure-2\.md\)/);
  assert.match(report, /\[Annexure 3\]\(\.\/annexure-3\.md\)/);
  assert.match(report, /600 synth tokens/);

  const a1 = fs.readFileSync(path.join(dir, 'annexure-1.md'), 'utf8');
  assert.match(a1, /# Annexure 1/);
  assert.match(a1, /\*\*Task:\*\* Survey STT models/);
  assert.match(a1, /STT findings: Whisper INT4/);

  const a2 = fs.readFileSync(path.join(dir, 'annexure-2.md'), 'utf8');
  assert.match(a2, /\*\*Task:\*\* Compare local LLM/);
  assert.match(a2, /LLM findings: Phi-3/);

  const a3 = fs.readFileSync(path.join(dir, 'annexure-3.md'), 'utf8');
  assert.match(a3, /\*\*Task:\*\* Survey TTS models/);
});

// ── deep-mode (chain) — task descriptions come from spine:task ─────
check('deep-mode: spine:task captures descriptions for annexures', () => {
  const sink = new RunDirSink();
  const dir = sink.start({ outputDir: freshOutputDir(),query: 'Deep query', mode: 'deep' });
  const events: WorkflowEvent[] = [
    { type: 'research:start', agentCount: 2, mode: 'deep' },
    { type: 'spine:task', taskIndex: 0, taskCount: 2, description: 'Background research' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:return', agentId: 1, result: 'Background facts.' } as WorkflowEvent,
    { type: 'spine:task', taskIndex: 1, taskCount: 2, description: 'Synthesize implications' },
    { type: 'agent:spawn', agentId: 2, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:return', agentId: 2, result: 'Implications follow.' } as WorkflowEvent,
    { type: 'research:done', totalTokens: 200, totalToolCalls: 5, timeMs: 3000 },
    {
      type: 'synthesize:done',
      agentId: 10,
      ppl: 2.0,
      tokenCount: 300,
      toolCallCount: 1,
      timeMs: 1000,
    },
    { type: 'answer', text: 'Deep synth answer.' },
    { type: 'complete', data: {} },
  ];
  for (const ev of events) sink.handle(ev);

  const a1 = fs.readFileSync(path.join(dir, 'annexure-1.md'), 'utf8');
  assert.match(a1, /\*\*Task:\*\* Background research/);
  const a2 = fs.readFileSync(path.join(dir, 'annexure-2.md'), 'utf8');
  assert.match(a2, /\*\*Task:\*\* Synthesize implications/);
});

// ── synth agent (post-research:done) does NOT produce an annexure ──
check('synth agent:spawn (after research:done) is not annexed', () => {
  const sink = new RunDirSink();
  const dir = sink.start({ outputDir: freshOutputDir(),query: 'Synth-only query', mode: 'flat' });
  const events: WorkflowEvent[] = [
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'fanout:tasks', tasks: [{ description: 'Sole task' }] as never },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:return', agentId: 1, result: 'Research result.' } as WorkflowEvent,
    { type: 'research:done', totalTokens: 100, totalToolCalls: 1, timeMs: 1000 },
    { type: 'agent:spawn', agentId: 99, parentAgentId: 0 } as WorkflowEvent, // synth
    {
      type: 'synthesize:done',
      agentId: 99,
      ppl: 1.5,
      tokenCount: 150,
      toolCallCount: 1,
      timeMs: 500,
    },
    { type: 'answer', text: 'Synth answer.' },
    { type: 'complete', data: {} },
  ];
  for (const ev of events) sink.handle(ev);

  // Only annexure-1 should exist (research agent), not annexure-99 or any
  // file derived from the synth agent's id.
  assert.ok(fs.existsSync(path.join(dir, 'annexure-1.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'annexure-2.md')));
  const entries = fs.readdirSync(dir).filter((f) => f.startsWith('annexure-'));
  assert.equal(entries.length, 1);
});

// ── two queries → two run-dirs (no clobber) ────────────────────────
check('two consecutive starts → two distinct run-dirs', () => {
  const sink = new RunDirSink();
  const sharedDir = freshOutputDir();
  const d1 = sink.start({ outputDir: sharedDir, query: 'Q1', mode: 'flat' });
  // Force a 1-second gap so the ISO timestamps differ.
  const t = Date.now() + 1100;
  while (Date.now() < t) { /* spin */ }
  const d2 = sink.start({ outputDir: sharedDir, query: 'Q2', mode: 'flat' });
  assert.notEqual(d1, d2);
  assert.ok(fs.existsSync(d1));
  assert.ok(fs.existsSync(d2));
});

// ── ui:error mid-run resets without writing report.md ──────────────
check('ui:error mid-run does not write report.md', () => {
  const sink = new RunDirSink();
  const dir = sink.start({ outputDir: freshOutputDir(),query: 'Failing', mode: 'flat' });
  sink.handle({ type: 'research:start', agentCount: 1, mode: 'flat' });
  sink.handle({
    type: 'agent:spawn',
    agentId: 1,
    parentAgentId: 0,
  } as WorkflowEvent);
  sink.handle({ type: 'ui:error', message: 'something broke' });
  assert.ok(!fs.existsSync(path.join(dir, 'report.md')));
});

process.stdout.write(`---\nall passed (cleanup: ${tmpRoot})\n`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
