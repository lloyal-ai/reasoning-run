/**
 * Smoke tests for the clarify→spine rewrite (Phase Q1).
 *
 *   npx tsx src/__clarify-trunk-smoke.ts
 *
 * Two layers of coverage:
 *
 *   1. formatClarifyAsAssistantMsg correctness — the helper is the wire
 *      format committed to session.trunk on every clarify round, so it
 *      gets direct unit coverage (numbering, joining, empty/single/many).
 *
 *   2. Structural assertions on harness.ts and pipeline.ts — the command-loop
 *      rewrite is not testable end-to-end without booting llama.cpp, but
 *      its shape is observable from source. We assert that:
 *       - the legacy `Prior clarification exchange:` qa block is GONE;
 *       - `formatClarifyAsAssistantMsg(` is called in every clarify
 *         branch (auto-submit, submit_query, submit_clarification,
 *         change_mode) — four call sites;
 *       - `session.commitTurn(` is invoked at those clarify branches
 *         (i.e., clarify rounds extend the trunk);
 *       - `pendingPlan` carries the new `latestUserInput` field;
 *       - `accept_plan` threads `commitInput: pendingPlan.latestUserInput`
 *         to runResearchPlan;
 *       - `RunResearchPlanOpts.commitInput` exists in pipeline.ts and the
 *         final commit line uses `opts.commitInput ?? query`.
 *
 * The structural layer is a regression guard: any future refactor that
 * accidentally drops the trunk-commit semantics will trip these checks
 * without anyone having to re-run a full reasoning.run trace.
 *
 * End-to-end verification (the (latestUserInput, researchAnswer) commit
 * pairing observed live in a trace) stays as the manual verification step
 * in the Phase Q1 plan.
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

// ── Layer 1: helper unit tests ─────────────────────────────────────

// Re-implement the helper here for direct testing — keeping it in sync
// with harness.ts. (Importing from harness.ts would pull in the entire boot
// sequence as a transitive side-effect via the top-level `main(...)`
// call. The helper is a pure 4-line function — a faithful copy is the
// least-invasive way to unit-test it.)
function formatClarifyAsAssistantMsg(questions: readonly string[]): string {
  return [
    "I need to clarify a few things before researching:",
    "",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");
}

check("formatClarifyAsAssistantMsg: single question is 1-indexed", () => {
  const out = formatClarifyAsAssistantMsg(["What kind of model?"]);
  assert.equal(
    out,
    "I need to clarify a few things before researching:\n\n1. What kind of model?",
  );
});

check("formatClarifyAsAssistantMsg: multiple questions numbered + joined", () => {
  const out = formatClarifyAsAssistantMsg([
    "Best at what task?",
    "What constraints matter?",
    "Over what time horizon?",
  ]);
  const lines = out.split("\n");
  assert.equal(lines[0], "I need to clarify a few things before researching:");
  assert.equal(lines[1], ""); // blank separator
  assert.equal(lines[2], "1. Best at what task?");
  assert.equal(lines[3], "2. What constraints matter?");
  assert.equal(lines[4], "3. Over what time horizon?");
});

check("formatClarifyAsAssistantMsg: empty questions list produces preamble only", () => {
  const out = formatClarifyAsAssistantMsg([]);
  // Trailing newline because the spread is empty but the join keeps the
  // blank-separator line.
  assert.equal(out, "I need to clarify a few things before researching:\n");
});

check("formatClarifyAsAssistantMsg: questions with embedded newlines round-trip", () => {
  // Real planner output occasionally contains internal punctuation/newlines.
  // The helper should pass them through without mangling.
  const out = formatClarifyAsAssistantMsg(["Q with: punctuation", "Q with\nnewline"]);
  assert.match(out, /1\. Q with: punctuation/);
  assert.match(out, /2\. Q with\nnewline/);
});

// ── Layer 2: structural assertions on harness.ts ──────────────────────

// Smokes run from the reasoning.run package root (see `npm run smoke`).
const mainSrc = fs.readFileSync(path.join(process.cwd(), "src/harness.ts"), "utf8");
const harnessSrc = fs.readFileSync(
  path.join(process.cwd(), "src/pipeline.ts"),
  "utf8",
);

check("harness.ts: legacy `Prior clarification exchange:` qa block is GONE", () => {
  assert.ok(
    !mainSrc.includes("Prior clarification exchange:"),
    "Found legacy prompt-prose qa block — the rewrite did not remove it.",
  );
});

check("harness.ts: legacy `User response:` qa block prefix is GONE", () => {
  assert.ok(
    !mainSrc.includes("User response: ${cmd.answer}"),
    "Found legacy prompt-prose qa block — the rewrite did not remove it.",
  );
});

check("harness.ts: formatClarifyAsAssistantMsg defined + called from 3 sites", () => {
  // Q1.5: 1 definition + 3 call sites (auto-submit clarify, submit_query→clarify,
  // submit_clarification→clarify). change_mode→clarify deliberately skips the
  // commit per Q1.5 (non-conversational re-plan; documented edge).
  const occurrences = mainSrc.match(/formatClarifyAsAssistantMsg/g) ?? [];
  assert.equal(
    occurrences.length,
    4,
    `expected 1 definition + 3 call sites = 4 occurrences; got ${occurrences.length}`,
  );
});

check("harness.ts: first-round clarify uses session.commitTurn (atomic)", () => {
  // First-round emissions (auto-submit + submit_query) bootstrap the trunk
  // with an atomic (query, formattedQs) pair via commitTurn cold path.
  const occurrences = mainSrc.match(/session\.commitTurn\(/g) ?? [];
  assert.ok(
    occurrences.length >= 2,
    `expected ≥2 session.commitTurn calls in harness.ts (auto-submit + submit_query first-round); got ${occurrences.length}`,
  );
});

check("harness.ts: submit_clarification uses prefillUser before runQuery", () => {
  // Q1.5 core: the user's clarify answer must enter trunk BEFORE planner #2
  // forks, so the planner's KV inherits it.
  assert.ok(
    /session\.prefillUser\(cmd\.answer\)/.test(mainSrc),
    "submit_clarification must call session.prefillUser(cmd.answer) before runQuery",
  );
});

check("harness.ts: submit_clarification clarify result uses prefillAssistant", () => {
  // When planner #2 emits clarify, close the dangling user-side via
  // prefillAssistant (not commitTurn, which would re-emit cmd.answer).
  assert.ok(
    /session\.prefillAssistant\(\s*formatClarifyAsAssistantMsg/.test(mainSrc),
    "submit_clarification clarify branch must call session.prefillAssistant(formatClarifyAsAssistantMsg(...))",
  );
});

check("harness.ts: pendingPlan carries clarifyExchanged field", () => {
  assert.ok(
    mainSrc.includes("clarifyExchanged: boolean;"),
    "pendingPlan type missing `clarifyExchanged: boolean;` field",
  );
  // Five pendingPlan constructions (auto-submit×2, submit_query×2,
  // submit_clarification×2 via spread) must initialize or propagate.
  const explicitAssigns = mainSrc.match(/clarifyExchanged:/g) ?? [];
  assert.ok(
    explicitAssigns.length >= 6,
    `expected ≥6 clarifyExchanged references (1 type decl + ≥5 assigns); got ${explicitAssigns.length}`,
  );
});

check("harness.ts: legacy latestUserInput is GONE", () => {
  assert.ok(
    !mainSrc.includes("latestUserInput"),
    "latestUserInput should be removed in Q1.5 (replaced by clarifyExchanged + prefillUser/prefillAssistant split)",
  );
});

check("harness.ts: accept_plan threads userSidePending to runResearchPlan", () => {
  // accept_plan snapshots pendingPlan into `acceptedPlan` before clearing it
  // and starting the run in a child fiber (Stop escape hatch), then threads
  // the clarify flag from that snapshot. Match the snapshot var name.
  assert.ok(
    /userSidePending:\s*acceptedPlan\.clarifyExchanged/.test(mainSrc),
    "accept_plan branch must thread `userSidePending: acceptedPlan.clarifyExchanged` to runResearchPlan",
  );
});

// ── Layer 2b: structural assertions on pipeline.ts ──────────────────

check("pipeline.ts: RunResearchPlanOpts declares userSidePending field", () => {
  assert.ok(
    /userSidePending\?:\s*boolean/.test(harnessSrc),
    "RunResearchPlanOpts missing `userSidePending?: boolean` field",
  );
});

check("pipeline.ts: legacy commitInput field is GONE", () => {
  assert.ok(
    !/commitInput\?:\s*string/.test(harnessSrc),
    "RunResearchPlanOpts.commitInput should be removed in Q1.5",
  );
});

check("pipeline.ts: research-completion commit branches on userSidePending", () => {
  // userSidePending=true  → prefillAssistant(answer)  (clarify path)
  // userSidePending=false → commitTurn(query, answer) (no-clarify path)
  assert.ok(
    /opts\.userSidePending/.test(harnessSrc),
    "pipeline.ts research-completion commit must branch on opts.userSidePending",
  );
  assert.ok(
    /session\.prefillAssistant\(answer\)/.test(harnessSrc),
    "pipeline.ts clarify-path branch must call session.prefillAssistant(answer)",
  );
  assert.ok(
    /session\.commitTurn\(query,\s*answer\)/.test(harnessSrc),
    "pipeline.ts no-clarify branch must call session.commitTurn(query, answer)",
  );
});

process.stdout.write("---\nall passed\n");
