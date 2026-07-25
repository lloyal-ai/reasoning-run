/**
 * Smoke tests for the prompts/ override seam (Step 6a, Workstream C).
 *
 *   npx tsx src/__prompt-override-smoke.ts
 *
 * The 7 RACE/DRB-tuned prompts stay BAKED into the bundle (their `.eta` text is
 * imported at build time). A harness author can override any one by dropping
 * `prompts/<name>.eta` into the project tree; `resolvePrompt(name)` reads that
 * file when present, else the baked default. The load-bearing INVARIANT is that
 * an ABSENT / empty `prompts/` dir is byte-identical to today with ZERO
 * prompt-file I/O — so the override path must be gated on `existsSync`, and
 * `PromptsCtx` must default to null (baked, no disk touch).
 *
 * harness.ts can't be imported under tsx (its `.eta` prompt imports need the
 * esbuild text loader), so — like `__ask-policy-smoke.ts` — this is a structural
 * regression guard on the wiring. The behavioural guarantee (present override →
 * used; absent → baked, no read) is the manual verification step.
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

const BAKED_NAMES = [
  "preflight:",
  '"preflight-recover":',
  "plan:",
  '"plan-flat":',
  "recovery:",
  "synthesize:",
  '"synthesize-flat":',
];

check("harness.ts: BAKED map declares all 7 prompt names (every prompt has a baked fallback)", () => {
  assert.ok(/const BAKED = \{/.test(harnessSrc), "expected a `const BAKED = { ... }` map");
  for (const key of BAKED_NAMES) {
    assert.ok(harnessSrc.includes(key), `BAKED map missing key \`${key}\``);
  }
  assert.ok(
    /\}\s*as const satisfies Record<string, string>/.test(harnessSrc),
    "BAKED must be `as const satisfies Record<string, string>` (typed name→raw map)",
  );
  assert.ok(
    /export type PromptName = keyof typeof BAKED/.test(harnessSrc),
    "PromptName must be `keyof typeof BAKED` (names derived from the baked map)",
  );
});

check("harness.ts: PromptsCtx defaults to null (unset ⇒ baked path, zero disk I/O)", () => {
  assert.ok(
    /export const PromptsCtx = createContext<string \| null>\([^)]*,\s*null\)/.test(harnessSrc),
    "PromptsCtx must be `createContext<string | null>(..., null)` — a null default is the zero-I/O baked path",
  );
});

check("harness.ts: resolvePrompt reads PromptsCtx and falls back to BAKED before any disk touch", () => {
  assert.ok(
    /function\* resolvePrompt\(name: PromptName\): Operation<Prompt>/.test(harnessSrc),
    "expected `function* resolvePrompt(name: PromptName): Operation<Prompt>`",
  );
  assert.ok(
    /const dir = \(yield\* PromptsCtx\.get\(\)\) \?\? null/.test(harnessSrc),
    "resolvePrompt must read the override dir from `PromptsCtx.get()`",
  );
  assert.ok(
    /let raw: string = BAKED\[name\]/.test(harnessSrc),
    "the baked default must be assigned FIRST (`let raw = BAKED[name]`) so the no-override path never reads disk",
  );
});

check("harness.ts: an override file is read ONLY when the dir is set AND the file exists (existsSync-gated)", () => {
  // This is the invariant: no override dir ⇒ the `if (dir)` block is skipped
  // entirely ⇒ no stat, no read. A present dir stats the specific file and reads
  // it only if it exists — else the baked default stands.
  assert.ok(
    /if \(dir\) \{[\s\S]*?if \(existsSync\(file\)\) raw = readFileSync\(file, "utf8"\);[\s\S]*?\}/.test(
      harnessSrc,
    ),
    "resolvePrompt must gate `readFileSync` behind `if (dir)` + `if (existsSync(file))`",
  );
  // readFileSync must appear nowhere else in the prompt path (single controlled read site).
  assert.equal(
    (harnessSrc.match(/readFileSync\(/g) ?? []).length,
    1,
    "expected exactly one readFileSync call site (inside resolvePrompt's existsSync guard)",
  );
});

check("harness.ts: resolvePrompt memoizes per (dir,name) — an override reads disk at most once", () => {
  assert.ok(/const hit = promptMemo\.get\(key\)/.test(harnessSrc), "resolvePrompt must consult `promptMemo`");
  assert.ok(/promptMemo\.set\(key, parsed\)/.test(harnessSrc), "resolvePrompt must populate `promptMemo`");
});

check("harness.ts: the 7 frozen `parsePrompt(*_RAW)` consts are gone (all prompts route through resolvePrompt)", () => {
  assert.ok(
    !/const \w+ = parsePrompt\(\w+_RAW\)/.test(harnessSrc),
    "no top-level `const X = parsePrompt(X_RAW)` frozen consts should remain — prompts resolve lazily",
  );
  assert.equal(
    (harnessSrc.match(/parsePrompt\(raw\)/g) ?? []).length,
    1,
    "parsePrompt must be called exactly once — from inside resolvePrompt (`parsePrompt(raw)`)",
  );
  for (const site of [
    /yield\* resolvePrompt\("preflight"\)/,
    /yield\* resolvePrompt\("preflight-recover"\)/,
    /yield\* resolvePrompt\(opts\.reasoningMode === "flat" \? "plan-flat" : "plan"\)/,
    /yield\* resolvePrompt\("recovery"\)/,
    /yield\* resolvePrompt\(\s*opts\.reasoningMode === "flat" \? "synthesize-flat" : "synthesize"/,
  ]) {
    assert.ok(site.test(harnessSrc), `missing resolvePrompt call site: ${site}`);
  }
});

check("harness.ts: recovery prompt is threaded as a resolved Prompt into both policy factories", () => {
  assert.ok(
    /function createReconPolicy\(recoverPrompt: Prompt\)/.test(harnessSrc),
    "createReconPolicy must take the resolved recovery `Prompt` as an arg",
  );
  assert.ok(
    /function createResearchPolicy\([\s\S]*?recoveryPrompt: Prompt,?\s*\)/.test(harnessSrc),
    "createResearchPolicy must take the resolved recovery `Prompt` as its final arg",
  );
  assert.ok(
    /createResearchPolicy\(opts\.effort, opts\.reasoningMode, opts\.isAsk, recoveryPrompt\)/.test(harnessSrc),
    "runResearchPlan must pass the resolved `recoveryPrompt` into createResearchPolicy",
  );
});

check("main.ts: PromptsCtx is set ONLY under an existsSync guard (absent prompts/ ⇒ no set, zero prompt I/O)", () => {
  assert.ok(/PromptsCtx,/.test(mainSrc), "main.ts must import `PromptsCtx` from ./harness");
  assert.ok(
    /const promptsDir = path\.join\(process\.cwd\(\), "prompts"\)/.test(mainSrc),
    "prompts dir must be cwd-relative (matches harness.json's DEFAULT_CONFIG_PATH convention)",
  );
  assert.ok(
    /if \(fs\.existsSync\(promptsDir\)\) yield\* PromptsCtx\.set\(promptsDir\)/.test(mainSrc),
    "PromptsCtx.set must be gated on `fs.existsSync(promptsDir)` — the zero-I/O-when-absent invariant",
  );
});

check("main.ts: PromptsCtx.set appears exactly once (single boot-time seam)", () => {
  assert.equal(
    (mainSrc.match(/PromptsCtx\.set/g) ?? []).length,
    1,
    "expected exactly one PromptsCtx.set (inside harness(), covering both runMain and runServedSession)",
  );
});

process.stdout.write("---\nall passed\n");
