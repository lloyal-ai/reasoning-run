/**
 * Smoke tests for the Ask direct-answer fix.
 *
 *   npx tsx src/__ask-policy-smoke.ts
 *
 * Ask mode (`skipPlanner`) routes a single warm-forked agent through
 * `createResearchPolicy`. A vanilla `DefaultAgentPolicy` gates accepting free text
 * as the agent's result behind `toolCallCount > 0` (the anti-lazy-research guard), so
 * an Ask agent that answers DIRECTLY from the prior report's context with 0 tool calls
 * had its answer discarded (`pool:recoveryFailed reason=recovery_skipped`). The fix:
 * an Ask run uses `DirectAnswerPolicy` (the `SynthPolicy` override, generalized) which
 * returns `free_text_return` for 0-tool free text → the answer is captured as a
 * voluntary `agent:return`, no drop/recovery.
 *
 * harness.ts can't be imported under tsx (its `.eta` prompt imports need the esbuild
 * text loader), so — like `__clarify-trunk-smoke.ts` — this is a structural regression
 * guard on the wiring. The behavioural guarantee (free_text_return → agent:return, no
 * recovery) is the framework's existing contract (agent-pool `handleFreeTextReturn`).
 * The live repro (Ask "explain X like I'm 10 from what you found" → answer captured,
 * no "Recovery failed") stays the manual verification step.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

function check(label: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n`);
    throw err;
  }
}

// Smokes run from the reasoning.run package root (see `npm run smoke`).
const harnessSrc = fs.readFileSync(path.join(process.cwd(), "src/harness.ts"), "utf8");
const mainSrc = fs.readFileSync(path.join(process.cwd(), "src/main.ts"), "utf8");

check("harness.ts: SynthPolicy renamed to DirectAnswerPolicy (shared by synth + Ask)", () => {
  assert.ok(
    /class DirectAnswerPolicy extends DefaultAgentPolicy/.test(harnessSrc),
    "expected `class DirectAnswerPolicy extends DefaultAgentPolicy`",
  );
  assert.ok(
    !harnessSrc.includes("SynthPolicy"),
    "legacy `SynthPolicy` should be renamed to `DirectAnswerPolicy` (no lingering references)",
  );
});

check("harness.ts: synth still uses the direct-answer policy", () => {
  assert.ok(
    /policy:\s*new DirectAnswerPolicy\(\)/.test(harnessSrc),
    "synth useAgent must construct `new DirectAnswerPolicy()`",
  );
});

check("harness.ts: DirectAnswerPolicy keeps the free_text_return override", () => {
  assert.ok(
    /free_text_return/.test(harnessSrc),
    "DirectAnswerPolicy must return `free_text_return` for 0-tool free text",
  );
});

check("harness.ts: createResearchPolicy takes isAsk + picks the class", () => {
  assert.ok(
    /function createResearchPolicy\([\s\S]*?isAsk\s*=\s*false/.test(harnessSrc),
    "createResearchPolicy must accept an `isAsk = false` param",
  );
  assert.ok(
    /return isAsk\s*\?\s*new DirectAnswerPolicy\(opts\)\s*:\s*new DefaultAgentPolicy\(opts\)/.test(harnessSrc),
    "createResearchPolicy must return DirectAnswerPolicy for Ask, DefaultAgentPolicy otherwise",
  );
});

check("harness.ts: Ask relaxes recovery so a dropped Ask agent is salvaged, not skipped", () => {
  assert.ok(
    /isAsk[\s\S]*?minToolCalls:\s*0,\s*minTokens:\s*0/.test(harnessSrc),
    "Ask recovery must set minToolCalls:0 + minTokens:0 (salvage involuntary drops)",
  );
});

check("harness.ts: RunResearchPlanOpts declares isAsk + policy line threads it", () => {
  assert.ok(/isAsk\?:\s*boolean/.test(harnessSrc), "RunResearchPlanOpts missing `isAsk?: boolean`");
  assert.ok(
    /createResearchPolicy\(opts\.effort,\s*opts\.reasoningMode,\s*opts\.isAsk\)/.test(harnessSrc),
    "runResearchPlan must pass `opts.isAsk` into createResearchPolicy",
  );
});

check("main.ts: skipPlanner (Ask) branch threads isAsk to runResearchPlan", () => {
  assert.ok(
    /isAsk:\s*cmd\.skipPlanner/.test(mainSrc),
    "main.ts skipPlanner runResearchPlan call must pass `isAsk: cmd.skipPlanner`",
  );
});

check("main.ts: isAsk is set ONLY in the Ask branch (no Research path enables it)", () => {
  // Tight-wiring guard: the permissive DirectAnswerPolicy must be reachable ONLY via
  // the skipPlanner/Ask branch. Every other runResearchPlan call (accept_plan,
  // headless research_plan, passthrough-cold degrade) must leave isAsk undefined →
  // strict DefaultAgentPolicy. A second `isAsk:` setter here would mean a Research run
  // could silently use the ungrounded policy — the core-UX regression to prevent.
  const occurrences = mainSrc.match(/isAsk:/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    `expected exactly 1 isAsk: setter (the Ask branch); got ${occurrences.length} — a Research path may be enabling Ask permissiveness`,
  );
});

process.stdout.write("---\nall passed\n");
