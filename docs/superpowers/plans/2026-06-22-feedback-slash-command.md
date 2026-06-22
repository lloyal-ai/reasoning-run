# /feedback Slash Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/feedback` TUI command to reasoning.run that opens a prefilled GitHub issue capturing the user's message plus — on explicit opt-in — scrubbed session errors and non-sensitive environment info.

**Architecture:** A Composer-local `FeedbackPanel` overlay (mirroring the existing inline-editor pattern) runs a 3-step flow: message → error-consent → open-confirm. It reads an `errors` buffer and `env` meta from `AppState`, composes the issue body/URL with pure helpers in `feedback.ts`, and dispatches a single `open_feedback` command that `main.ts` turns into a per-platform browser open. Nothing transmits until the user clicks **Submit** in their browser.

**Tech Stack:** TypeScript (Node 22, ESM), Ink 7 + React 19, Effection 4. No new dependencies (browser open via `node:child_process`). Tests are `tsx`-run smoke scripts wired into `package.json`'s `smoke`.

## Global Constraints

- **No new npm dependencies.** Browser open uses `node:child_process` `spawn`.
- **Destination:** `https://github.com/lloyal-ai/reasoning-run/issues/new` (public issue), label `feedback` (optional — GitHub silently ignores an absent label).
- **Submission = prefilled browser URL only.** No GitHub API, no shipped token. Consent = the user reviews the prefilled issue and clicks Submit.
- **Error payload = scrubbed messages only.** Never attach the full `trace-*.jsonl`. Scrubbing is best-effort (see Task 2).
- **URL length** enforced on the **percent-encoded** URL, cap `MAX_ENCODED_URL = 7000`. Errors truncate first, then the message; environment always survives.
- **Reset survival:** `errors` and `env` MUST be preserved in the reducer's `query` and `preflight:start` reset branches.
- **GPU source:** `process.env.LLOYAL_GPU` (fallback `'unknown'`) — config has no GPU field.
- **TypeScript gate** for every task: `npx tsc --noEmit` passes. **Smoke gate:** `npm run smoke` passes.

---

### Task 1: State plumbing — errors buffer + env meta

**Files:**
- Modify: `src/tui-ink/state.ts` (add `ErrorRecord`, `EnvMeta`, two `AppState` fields, two `initialState` fields)
- Modify: `src/tui-ink/events.ts` (add `ui:env` event)
- Modify: `src/tui-ink/reducer.ts` (append on `ui:error`/`boot:error`, handle `ui:env`, preserve across resets)
- Test: `src/tui-ink/__reducer-smoke.ts` (append/cap/preserve/seed assertions)

**Interfaces:**
- Produces: `interface ErrorRecord { message: string; kind?: 'llm' | 'reranker'; at: number }`
- Produces: `interface EnvMeta { version: string; platform: string; arch: string; cpuModel: string; nodeVersion: string; gpu: string }`
- Produces: `AppState.errors: ErrorRecord[]`, `AppState.env: EnvMeta | null`
- Produces: WorkflowEvent `{ type: 'ui:env'; env: EnvMeta }`

- [ ] **Step 1: Write the failing reducer tests**

Append to `src/tui-ink/__reducer-smoke.ts` (before any trailing exit-code logic; the file is a flat list of `check(...)` calls):

```ts
check('ui:error appends to errors buffer', () => {
  const s = drive([{ type: 'ui:error', message: 'boom' }]);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].message, 'boom');
});

check('boot:error appends with kind', () => {
  const s = drive([{ type: 'boot:error', kind: 'llm', message: 'load failed' }]);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].kind, 'llm');
});

check('errors buffer is FIFO-capped at 20', () => {
  const evs: WorkflowEvent[] = [];
  for (let i = 0; i < 25; i++) evs.push({ type: 'ui:error', message: `e${i}` });
  const s = drive(evs);
  assert.equal(s.errors.length, 20);
  assert.equal(s.errors[0].message, 'e5');   // oldest 5 dropped
  assert.equal(s.errors[19].message, 'e24');
});

check('ui:env seeds env meta', () => {
  const env = { version: '0.3.1', platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M2', nodeVersion: 'v22.0.0', gpu: 'metal' };
  const s = drive([{ type: 'ui:env', env }]);
  assert.deepEqual(s.env, env);
});

check('query reset preserves errors + env', () => {
  const env = { version: '0.3.1', platform: 'linux', arch: 'x64', cpuModel: 'Ryzen 5 3600', nodeVersion: 'v22', gpu: 'cuda' };
  const s = drive([
    { type: 'ui:env', env },
    { type: 'ui:error', message: 'pre-query error' },
    { type: 'query', query: 'next', warm: false },
  ]);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].message, 'pre-query error');
  assert.deepEqual(s.env, env);
});

check('preflight:start reset preserves errors + env', () => {
  const env = { version: '0.3.1', platform: 'linux', arch: 'x64', cpuModel: 'Ryzen', nodeVersion: 'v22', gpu: 'cuda' };
  const s = drive([
    { type: 'ui:env', env },
    { type: 'ui:error', message: 'pre-preflight error' },
    { type: 'preflight:start', query: 'q', appCount: 2 },
  ]);
  assert.equal(s.errors.length, 1);
  assert.deepEqual(s.env, env);
});
```

- [ ] **Step 2: Run smoke to verify the new checks fail**

Run: `npm run smoke`
Expected: FAIL lines like `FAIL ui:error appends to errors buffer` / TypeScript errors about `s.errors` / `ui:env` not existing.

- [ ] **Step 3: Add the types and state fields**

In `src/tui-ink/state.ts`, add the two interfaces near the top of the export block (e.g. just above `export interface AppState`):

```ts
export interface ErrorRecord {
  /** The user-facing error message as surfaced via ui:error/boot:error. */
  message: string;
  /** Present for boot errors (model vs reranker). */
  kind?: 'llm' | 'reranker';
  at: number;
}

/** Non-sensitive environment snapshot for feedback issues. Assembled in
 *  main.ts (needs os/process) and delivered via the `ui:env` event. */
export interface EnvMeta {
  version: string;     // reasoning.run version (pkg.version)
  platform: string;    // os.platform()
  arch: string;        // os.arch()
  cpuModel: string;    // os.cpus()[0]?.model — practical AVX-512 signal
  nodeVersion: string; // process.version
  gpu: string;         // process.env.LLOYAL_GPU ?? 'unknown'
}
```

Add two fields to `AppState` (next to `participation`):

```ts
  /** Capped (≈20) FIFO of errors seen this session. Source for /feedback.
   *  Survives query/preflight resets so a crash isn't lost on the next ask. */
  errors: ErrorRecord[];
  /** Non-sensitive environment snapshot (seeded at boot via ui:env). */
  env: EnvMeta | null;
```

Add to `initialState` (next to `participation: {}`):

```ts
  errors: [],
  env: null,
```

- [ ] **Step 4: Add the `ui:env` event**

In `src/tui-ink/events.ts`, add an import and a union member. At the top with the other type imports:

```ts
import type { EnvMeta } from './state';
```

Add to the `StepEvent` union (next to `| { type: 'ui:error'; message: string }`):

```ts
  | { type: 'ui:env'; env: EnvMeta }
```

- [ ] **Step 5: Implement the reducer changes**

In `src/tui-ink/reducer.ts`, add a helper near the top (after the imports):

```ts
const MAX_ERRORS = 20;
function appendError(buf: AppState['errors'], rec: AppState['errors'][number]): AppState['errors'] {
  const next = [...buf, rec];
  return next.length > MAX_ERRORS ? next.slice(next.length - MAX_ERRORS) : next;
}
```

Update the `ui:error` case (currently ~`reducer.ts:564`) to also append:

```ts
    case 'ui:error': {
      const toastId = state.nextToastId + 1;
      return {
        ...state,
        uiPhase: 'composer',
        toast: { id: toastId, message: ev.message, tone: 'error' },
        nextToastId: toastId,
        errors: appendError(state.errors, { message: ev.message, at: Date.now() }),
      };
    }
```

Update the `boot:error` case (~`reducer.ts:640`):

```ts
    case 'boot:error':
      return {
        ...state,
        uiPhase: 'boot_error',
        bootError: { kind: ev.kind, message: ev.message },
        errors: appendError(state.errors, { message: ev.message, kind: ev.kind, at: Date.now() }),
      };
```

Add a new case (place near `ui:error`):

```ts
    case 'ui:env':
      return { ...state, env: ev.env };
```

In the `query` reset (~`reducer.ts:249`) add two preserved fields inside the returned object:

```ts
        errors: state.errors,
        env: state.env,
```

In the `preflight:start` reset (~`reducer.ts:485`) add the same two lines inside the returned object:

```ts
        errors: state.errors,
        env: state.env,
```

- [ ] **Step 6: Run smoke to verify pass + typecheck**

Run: `npm run smoke && npx tsc --noEmit`
Expected: all `ok` lines including the six new checks; `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/tui-ink/state.ts src/tui-ink/events.ts src/tui-ink/reducer.ts src/tui-ink/__reducer-smoke.ts
git commit -m "feat(tui): errors buffer + env meta in AppState for /feedback"
```

---

### Task 2: Pure feedback helpers (`feedback.ts`)

**Files:**
- Create: `src/tui-ink/feedback.ts`
- Test: `src/tui-ink/__feedback-smoke.ts`
- Modify: `package.json` (add the new smoke script to the `smoke` chain)

**Interfaces:**
- Consumes: `EnvMeta`, `ErrorRecord` (Task 1), `Config` (`./config`)
- Produces:
  - `scrubError(message: string, ctx: ScrubCtx): string`
  - `formatEnvLines(env: EnvMeta | null, config: Config | null, mode: 'flat' | 'deep' | null): string[]`
  - `feedbackTitle(message: string): string`
  - `buildFeedbackBody(input: BuildBodyInput): { body: string; truncated: boolean }`
  - `buildIssueUrl(input: { title: string; body: string }): string`
  - types `ScrubCtx`, `BuildBodyInput`

- [ ] **Step 1: Write the failing helper tests**

Create `src/tui-ink/__feedback-smoke.ts`:

```ts
/**
 * feedback.ts smoke test — pure helpers for the /feedback command.
 *   npx tsx src/tui-ink/__feedback-smoke.ts
 */
import assert from 'node:assert';
import {
  scrubError,
  feedbackTitle,
  buildFeedbackBody,
  buildIssueUrl,
} from './feedback';
import type { EnvMeta } from './state';

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

const ENV: EnvMeta = {
  version: '0.3.1', platform: 'linux', arch: 'x64',
  cpuModel: 'AMD Ryzen 5 3600', nodeVersion: 'v22.0.0', gpu: 'cuda',
};

check('scrubError basenames a POSIX path', () => {
  const out = scrubError('Cannot use /home/jo/matters/secret.gguf: bad', { homeDir: '/home/jo' });
  assert.ok(!out.includes('/home/jo/matters'), out);
  assert.ok(out.includes('secret.gguf'), out);
});

check('scrubError basenames a Windows path', () => {
  const out = scrubError('load C:\\Users\\Jo\\corpus\\brief.md failed', {});
  assert.ok(!out.includes('C:\\Users\\Jo'), out);
  assert.ok(out.includes('brief.md'), out);
});

check('scrubError redacts the session query', () => {
  const out = scrubError('Research failed for "merger of Acme and Beta": HTTP 500', { query: 'merger of Acme and Beta' });
  assert.ok(!out.includes('merger of Acme and Beta'), out);
  assert.ok(out.includes('[query]'), out);
});

check('scrubError strips URL query strings', () => {
  const out = scrubError('GET https://api.x.com/s?key=tvly-abc&q=secret 401', {});
  assert.ok(!out.includes('key=tvly-abc'), out);
});

check('feedbackTitle truncates long messages', () => {
  const t = feedbackTitle('x'.repeat(200));
  assert.ok(t.startsWith('Feedback: '), t);
  assert.ok(t.length <= 'Feedback: '.length + 60, t);
});

check('buildFeedbackBody includes message + environment, omits errors when not consented', () => {
  const { body } = buildFeedbackBody({
    message: 'great tool', env: ENV, config: null, mode: 'flat',
    errors: [{ message: 'boom', at: 0 }], includeErrors: false, scrubCtx: {},
  });
  assert.ok(body.includes('great tool'), body);
  assert.ok(body.includes('AMD Ryzen 5 3600'), body);
  assert.ok(!body.includes('boom'), body);
});

check('buildFeedbackBody includes scrubbed errors when consented', () => {
  const { body } = buildFeedbackBody({
    message: 'hit a crash', env: ENV, config: null, mode: 'deep',
    errors: [{ message: 'createContext STATUS_ILLEGAL_INSTRUCTION', at: 0 }],
    includeErrors: true, scrubCtx: {},
  });
  assert.ok(body.includes('STATUS_ILLEGAL_INSTRUCTION'), body);
});

check('buildFeedbackBody truncates errors first under the cap, keeps message+env', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ message: 'X'.repeat(400) + i, at: 0 }));
  const { body, truncated } = buildFeedbackBody({
    message: 'short note', env: ENV, config: null, mode: 'flat',
    errors: big, includeErrors: true, scrubCtx: {},
  });
  assert.equal(truncated, true);
  assert.ok(body.includes('short note'), 'message kept');
  assert.ok(body.includes('AMD Ryzen 5 3600'), 'env kept');
  assert.ok(/truncated/i.test(body), 'truncation marker present');
});

check('buildIssueUrl encodes and stays under GitHub cap', () => {
  const url = buildIssueUrl({ title: 'Feedback: hi', body: '## x\nbody & more <stuff>' });
  assert.ok(url.startsWith('https://github.com/lloyal-ai/reasoning-run/issues/new?'), url);
  assert.ok(url.includes('labels=feedback'), url);
  assert.ok(url.includes('title='), url);
  assert.ok(url.includes('body='), url);
  assert.ok(!url.includes(' '), 'no raw spaces');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/tui-ink/__feedback-smoke.ts`
Expected: FAIL — `Cannot find module './feedback'`.

- [ ] **Step 3: Implement `feedback.ts`**

Create `src/tui-ink/feedback.ts`:

```ts
/**
 * Pure helpers for the /feedback command. No I/O, no side effects — every
 * function is deterministic given its inputs, so the smoke test can pin them.
 *
 * The body is composed to fit GitHub's prefilled-issue URL limit, enforced
 * on the PERCENT-ENCODED length. Errors are best-effort scrubbed (an error
 * message is an arbitrary string — we cannot guarantee no corpus content,
 * only minimise it; the user reviews the issue before submitting).
 */
import type { Config } from './config';
import type { EnvMeta, ErrorRecord } from './state';

const ISSUE_BASE = 'https://github.com/lloyal-ai/reasoning-run/issues/new';
const ISSUE_LABEL = 'feedback';
/** Encoded-URL ceiling; GitHub rejects ~>8KB. Headroom for base + title. */
const MAX_ENCODED_URL = 7000;
const MAX_TITLE = 60;
const MAX_ERROR_LEN = 300;

export interface ScrubCtx {
  query?: string;
  homeDir?: string;
  /** Absolute paths to redact to basenames (model/reranker/corpus/output). */
  paths?: string[];
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export function scrubError(message: string, ctx: ScrubCtx): string {
  let s = message;
  // 1. Redact the session query verbatim, if present.
  if (ctx.query && ctx.query.trim()) {
    s = s.split(ctx.query).join('[query]');
  }
  // 2. Strip URL query strings (may carry keys / search terms).
  s = s.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1');
  // 3. Configured paths → basename.
  for (const p of ctx.paths ?? []) {
    if (p && s.includes(p)) s = s.split(p).join(basename(p));
  }
  // 4. Home dir → ~.
  if (ctx.homeDir && ctx.homeDir.trim()) s = s.split(ctx.homeDir).join('~');
  // 5. Remaining absolute paths (POSIX + Windows + UNC) → basename.
  s = s.replace(/(?:[A-Za-z]:\\|\\\\|\/)[^\s:?"<>|]+/g, (m) => basename(m));
  // 6. Length bound.
  if (s.length > MAX_ERROR_LEN) s = s.slice(0, MAX_ERROR_LEN) + '…';
  return s.trim();
}

export function feedbackTitle(message: string): string {
  const firstLine = (message.split('\n')[0] ?? '').trim() || 'feedback';
  const clipped = firstLine.length > MAX_TITLE ? firstLine.slice(0, MAX_TITLE) : firstLine;
  return `Feedback: ${clipped}`;
}

export function formatEnvLines(
  env: EnvMeta | null,
  config: Config | null,
  mode: 'flat' | 'deep' | null,
): string[] {
  const lines: string[] = [];
  if (env) {
    lines.push(`- reasoning.run: ${env.version}`);
    lines.push(`- OS: ${env.platform} ${env.arch}`);
    lines.push(`- CPU: ${env.cpuModel}`);
    lines.push(`- Node: ${env.nodeVersion}`);
    lines.push(`- GPU: ${env.gpu}`);
  }
  const modelPath = config?.model.path;
  const rerankPath = config?.model.reranker;
  if (modelPath) lines.push(`- Model: ${basename(modelPath)}`);
  if (rerankPath) lines.push(`- Reranker: ${basename(rerankPath)}`);
  if (mode) lines.push(`- Mode: ${mode}`);
  return lines;
}

export interface BuildBodyInput {
  message: string;
  env: EnvMeta | null;
  config: Config | null;
  mode: 'flat' | 'deep' | null;
  errors: ErrorRecord[];
  includeErrors: boolean;
  scrubCtx: ScrubCtx;
}

function encodedLen(title: string, body: string): number {
  return (
    ISSUE_BASE.length +
    '?labels='.length + ISSUE_LABEL.length +
    '&title='.length + encodeURIComponent(title).length +
    '&body='.length + encodeURIComponent(body).length
  );
}

export function buildFeedbackBody(input: BuildBodyInput): { body: string; truncated: boolean } {
  const { message, env, config, mode, errors, includeErrors, scrubCtx } = input;
  const envLines = formatEnvLines(env, config, mode);
  const header = (msg: string) => `${msg}\n\n## Environment\n${envLines.join('\n')}\n`;
  const title = feedbackTitle(message);

  let truncated = false;

  // 1. Message + environment always fit; truncate the message if even that overflows.
  let msg = message;
  while (encodedLen(title, header(msg)) > MAX_ENCODED_URL && msg.length > 0) {
    truncated = true;
    msg = msg.slice(0, Math.max(0, msg.length - 64));
  }
  if (truncated) msg = msg.replace(/\s*$/, '') + '\n…(truncated)';
  let body = header(msg);

  // 2. Add scrubbed errors greedily while they fit.
  if (includeErrors && errors.length) {
    const scrubbed = errors.map((e) => scrubError(e.message, scrubCtx)).filter(Boolean);
    const kept: string[] = [];
    for (let i = 0; i < scrubbed.length; i++) {
      const candidate = kept.concat(scrubbed[i]);
      const section = `\n## Errors (${candidate.length})\n` +
        candidate.map((m, j) => `${j + 1}. ${m}`).join('\n') + '\n';
      if (encodedLen(title, header(msg) + section) > MAX_ENCODED_URL) {
        truncated = true;
        break;
      }
      kept.push(scrubbed[i]);
    }
    if (kept.length) {
      const omitted = scrubbed.length - kept.length;
      const note = omitted > 0 ? `\n_(+${omitted} more errors truncated)_\n` : '';
      body = header(msg) +
        `\n## Errors (${kept.length})\n` +
        kept.map((m, j) => `${j + 1}. ${m}`).join('\n') + '\n' + note;
    }
  }

  return { body, truncated };
}

export function buildIssueUrl(input: { title: string; body: string }): string {
  const q = `?labels=${ISSUE_LABEL}` +
    `&title=${encodeURIComponent(input.title)}` +
    `&body=${encodeURIComponent(input.body)}`;
  return ISSUE_BASE + q;
}
```

- [ ] **Step 4: Run the feedback smoke to verify pass**

Run: `npx tsx src/tui-ink/__feedback-smoke.ts`
Expected: all `ok` lines, no `FAIL`.

- [ ] **Step 5: Wire it into the `smoke` script**

In `package.json`, append to the `smoke` script chain (after `__config-smoke.ts`):

```
 && tsx src/tui-ink/__feedback-smoke.ts
```

- [ ] **Step 6: Run full smoke + typecheck**

Run: `npm run smoke && npx tsc --noEmit`
Expected: all `ok`; `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/tui-ink/feedback.ts src/tui-ink/__feedback-smoke.ts package.json
git commit -m "feat(tui): pure feedback body/url/scrub helpers + smoke"
```

---

### Task 3: `open_feedback` command + main.ts env seeding & browser open

**Files:**
- Modify: `src/tui-ink/commands.ts` (add `open_feedback`)
- Modify: `src/main.ts` (seed `ui:env` after config load; handle `open_feedback`)

**Interfaces:**
- Consumes: `EnvMeta` (Task 1), `buildIssueUrl` shape (Task 2 — the URL string)
- Produces: command `{ type: 'open_feedback'; url: string }`; a `ui:env` event emitted once at boot

- [ ] **Step 1: Add the command type**

In `src/tui-ink/commands.ts`, add to the `Command` union (before `| { type: 'quit' }`):

```ts
  | { type: 'open_feedback'; url: string }
```

- [ ] **Step 2: Add an env-assembly helper + emit `ui:env` after config load**

In `src/main.ts`, confirm `pkg` is imported (models.ts uses `import pkg from "../package.json"`). If `pkg` is not already imported in main.ts, add at the top with the other imports:

```ts
import pkg from "../package.json";
```

Add a helper near the top-level helpers (e.g. beside `errorMessage`):

```ts
function buildEnvMeta(config: { model?: { path?: string } } | null): import("./tui-ink/state").EnvMeta {
  const os = require("node:os") as typeof import("node:os");
  const cpu = os.cpus?.()[0]?.model ?? "unknown";
  return {
    version: pkg.version,
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpu,
    nodeVersion: process.version,
    gpu: process.env.LLOYAL_GPU ?? "unknown",
  };
}
```

> Note: if main.ts already imports `os` from `node:os` at module top (it imports `spawn`; check the import block), use that import instead of `require` and drop the inner `require` line. Either is acceptable; prefer the existing top-level `import * as os from "node:os"` if present.

Immediately after the first `config:loaded` send (the seed at ~`main.ts:340`, inside the `uiChannel.send({ type: "config:loaded", ... })` block), send the env once:

```ts
    uiChannel.send({ type: "ui:env", env: buildEnvMeta(/* config */ null) });
```

(The env's config-derived fields — model/reranker basenames — are read by the panel from `state.config` directly, so `buildEnvMeta` does not need the resolved config; pass `null`.)

- [ ] **Step 3: Handle `open_feedback` in the interactive command loop**

In `src/main.ts`, inside the main interactive command loop (the `for (const cmd of yield* each(commands))` block at ~`main.ts:847`, alongside the `set_output_dir` / `set_corpus_path` branches), add a branch:

```ts
          } else if (cmd.type === "open_feedback") {
            try {
              const { spawn: cpSpawn } = require("node:child_process") as typeof import("node:child_process");
              const url = cmd.url;
              let child;
              if (process.platform === "darwin") {
                child = cpSpawn("open", [url], { stdio: "ignore", detached: true });
              } else if (process.platform === "win32") {
                // `start` is a cmd.exe builtin — cannot be spawned directly.
                child = cpSpawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
              } else {
                child = cpSpawn("xdg-open", [url], { stdio: "ignore", detached: true });
              }
              child.on("error", () => { /* best-effort; panel shows the URL */ });
              child.unref();
            } catch {
              // Swallow — the FeedbackPanel keeps the URL on screen for manual copy.
            }
```

> Match the surrounding branch style (the loop uses `if (cmd.type === ...) { } else if (...)`). Place this as another `else if` in that chain. Do not `yield* events.send({ type: "ui:composer" })` here — the panel manages its own close.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0. (No unit test here — this is I/O glue; the gate is typecheck + the manual run in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/tui-ink/commands.ts src/main.ts
git commit -m "feat(tui): open_feedback command + ui:env seeding + browser open"
```

---

### Task 4: `FeedbackPanel` component

**Files:**
- Create: `src/tui-ink/components/FeedbackPanel.tsx`

**Interfaces:**
- Consumes: `AppState` fields `errors`, `env`, `config`, `mode`, `query`; `useCommand` dispatch; `buildFeedbackBody`, `buildIssueUrl`, `feedbackTitle` (Task 2); `TextInput` (`./TextInput`)
- Produces: `FeedbackPanel` React component with props:
  ```ts
  interface FeedbackPanelProps {
    state: AppState;
    initialMessage: string;
    onClose: () => void;
  }
  ```

- [ ] **Step 1: Implement the panel**

Create `src/tui-ink/components/FeedbackPanel.tsx`:

```tsx
/**
 * /feedback flow — a Composer-local overlay (not a uiPhase). Three steps:
 *   1. message  — single-line input (pre-filled from inline arg)
 *   2. errors   — consent to attach scrubbed session errors (only if any)
 *   3. confirm  — open the prefilled GitHub issue in the browser
 *   4. opened   — keep the URL visible for manual copy, Enter closes
 *
 * Nothing is sent here: dispatching open_feedback only opens a prefilled
 * issue the user reviews and submits themselves.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput';
import { useCommand } from '../hooks/useCommand';
import type { AppState } from '../state';
import {
  buildFeedbackBody, buildIssueUrl, feedbackTitle, type ScrubCtx,
} from '../feedback';

export interface FeedbackPanelProps {
  state: AppState;
  initialMessage: string;
  onClose: () => void;
}

type Step = 'message' | 'errors' | 'confirm' | 'opened';

export function FeedbackPanel({ state, initialMessage, onClose }: FeedbackPanelProps): React.ReactElement {
  const dispatch = useCommand();
  const [step, setStep] = useState<Step>('message');
  const [message, setMessage] = useState(initialMessage);
  const [includeErrors, setIncludeErrors] = useState(false);
  const [openUrl, setOpenUrl] = useState('');
  const [wasTruncated, setWasTruncated] = useState(false);

  const errorCount = state.errors.length;

  const scrubCtx: ScrubCtx = {
    query: state.query || undefined,
    homeDir: process.env.HOME ?? process.env.USERPROFILE ?? undefined,
    paths: [
      state.config?.model.path,
      state.config?.model.reranker,
      state.config?.sources.corpusPath,
      state.config?.sources.outputDir,
    ].filter((p): p is string => !!p),
  };

  const compose = (withErrors: boolean) => {
    const { body, truncated } = buildFeedbackBody({
      message: message.trim() || '(no message)',
      env: state.env,
      config: state.config,
      mode: state.mode,
      errors: state.errors,
      includeErrors: withErrors,
      scrubCtx,
    });
    const url = buildIssueUrl({ title: feedbackTitle(message.trim() || 'feedback'), body });
    return { url, truncated };
  };

  const goOpen = (withErrors: boolean) => {
    const { url, truncated } = compose(withErrors);
    setOpenUrl(url);
    setWasTruncated(truncated);
    dispatch({ type: 'open_feedback', url });
    setStep('opened');
  };

  // Step 1: message input handled by TextInput (Enter advances, Esc cancels).
  if (step === 'message') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Send feedback (opens a prefilled GitHub issue you review &amp; submit)</Text>
        <Box>
          <Text color="yellow">Your feedback › </Text>
          <TextInput
            value={message}
            onChange={setMessage}
            onSubmit={() => {
              if (!message.trim()) { onClose(); return; }
              setStep(errorCount > 0 ? 'errors' : 'confirm');
            }}
            onCancel={onClose}
            focused
            placeholder="What worked, what didn't…"
          />
        </Box>
        <Text dimColor>Enter to continue · Esc to cancel</Text>
      </Box>
    );
  }

  // Step 2: error-attach consent (only reached when errorCount > 0).
  if (step === 'errors') {
    return (
      <Box flexDirection="column">
        <ErrorConsent
          count={errorCount}
          onYes={() => { setIncludeErrors(true); setStep('confirm'); }}
          onNo={() => { setIncludeErrors(false); setStep('confirm'); }}
          onCancel={onClose}
        />
      </Box>
    );
  }

  // Step 3: open-confirm.
  if (step === 'confirm') {
    return (
      <Box flexDirection="column">
        <OpenConfirm
          includeErrors={includeErrors}
          errorCount={errorCount}
          onYes={() => goOpen(includeErrors)}
          onCancel={onClose}
        />
      </Box>
    );
  }

  // Step 4: opened — keep URL visible for manual copy.
  return (
    <Box flexDirection="column">
      <Text color="green">Opened a prefilled GitHub issue in your browser — review it and click “Submit new issue”.</Text>
      {wasTruncated ? (
        <Text color="yellow">Note: your message/errors were shortened to fit GitHub's URL limit.</Text>
      ) : null}
      <Text dimColor>If your browser didn't open, copy this URL:</Text>
      <Text wrap="wrap">{openUrl}</Text>
      <Text dimColor>Enter to close</Text>
      <CloseOnEnter onClose={onClose} />
    </Box>
  );
}

function ErrorConsent({ count, onYes, onNo, onCancel }: {
  count: number; onYes: () => void; onNo: () => void; onCancel: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (input === 'y' || input === 'Y') onYes();
    else if (input === 'n' || input === 'N' || key.return) onNo();
  });
  return (
    <Box flexDirection="column">
      <Text>Attach {count} error{count === 1 ? '' : 's'} from this session? They'll appear in a <Text color="red">public</Text> GitHub issue (scrubbed: messages only).</Text>
      <Text dimColor>y = attach · n / Enter = don't attach · Esc = cancel</Text>
    </Box>
  );
}

function OpenConfirm({ includeErrors, errorCount, onYes, onCancel }: {
  includeErrors: boolean; errorCount: number; onYes: () => void; onCancel: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') onCancel();
    else if (key.return || input === 'y' || input === 'Y') onYes();
  });
  const errNote = includeErrors && errorCount > 0 ? ` with ${errorCount} error(s)` : '';
  return (
    <Box flexDirection="column">
      <Text>Open a prefilled GitHub issue{errNote} in your browser to review &amp; submit?</Text>
      <Text dimColor>Enter / y = open · n / Esc = cancel</Text>
    </Box>
  );
}

function CloseOnEnter({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput((_input, key) => { if (key.return || key.escape) onClose(); });
  return <Text> </Text>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0. If `config.model.path` / `sources.corpusPath` names differ, fix to the exact `Config` field names from `src/tui-ink/config.ts` (`ConfigModel`, `ConfigSources`).

- [ ] **Step 3: Commit**

```bash
git add src/tui-ink/components/FeedbackPanel.tsx
git commit -m "feat(tui): FeedbackPanel consent/open flow component"
```

---

### Task 5: Wire `/feedback` into Composer

**Files:**
- Modify: `src/tui-ink/components/Composer.tsx` (register command; open panel; render; gate input)

**Interfaces:**
- Consumes: `FeedbackPanel` (Task 4)
- Produces: user-visible `/feedback` command

- [ ] **Step 1: Register the command in `COMMANDS`**

In `src/tui-ink/components/Composer.tsx`, add to the `COMMANDS` array (after `output`, before `deep`):

```ts
  { name: 'feedback', desc: 'Send feedback (opens a prefilled GitHub issue)', kind: 'instant' },
```

(`instant` because the panel — not a value-set — handles input. The inline `<message>` is read off the parsed slash directly.)

- [ ] **Step 2: Add panel state + import**

Add the import near the other component imports:

```ts
import { FeedbackPanel } from './FeedbackPanel';
```

Add Composer-local state (next to `const [field, setField] = useState<Field>('query');`):

```ts
  const [feedback, setFeedback] = useState<{ message: string } | null>(null);
```

- [ ] **Step 3: Open the panel from `handleSlash`**

In `handleSlash`, the `instant` branch currently handles `deep`/`flat`/`quit`/`help`. Add `feedback` there — but it needs the parsed `value` (the inline message). Change the destructure and add the branch:

The function signature is `const handleSlash = ({ name, value }: ParsedSlash): void => {`. In the `if (cmd.kind === 'instant')` block, add:

```ts
      else if (name === 'feedback') { setFeedback({ message: value }); return; }
```

(`value` is `''` when the user typed bare `/feedback`.)

- [ ] **Step 4: Render the panel when active (early return)**

At the very top of the Composer's `return (` — i.e. before `<Box flexDirection="column" borderStyle="round" …>` — add an early return so the panel replaces the composer UI while active:

```tsx
  if (feedback) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <FeedbackPanel
          state={state}
          initialMessage={feedback.message}
          onClose={() => setFeedback(null)}
        />
      </Box>
    );
  }
```

- [ ] **Step 5: Gate Composer's `useInput` hooks while the panel is open**

The Composer registers two raw `useInput` hooks (query-focused ~`Composer.tsx:190`, chip-focused ~`Composer.tsx:246`). Ink runs `useInput` regardless of early return in the render body, so disable them while the panel owns input. Add `isActive` to each `useInput` options object (Ink's 2nd arg):

```ts
  useInput((input, key) => { /* existing handler */ }, { isActive: feedback === null });
```

Apply to **both** `useInput` calls. If a call already passes an options object, merge `isActive: feedback === null` into it (AND with any existing `isActive`).

- [ ] **Step 6: Typecheck + full smoke**

Run: `npx tsc --noEmit && npm run smoke`
Expected: `tsc` exits 0; all smoke `ok`.

- [ ] **Step 7: Manual run — verify the flow end to end**

Run: `npm run build && node bin/run.js`
Then in the TUI:
1. Type `/feedback this is a test` + Enter → consent/confirm panel appears (or error-consent first if the session has errors).
2. Choose to open → your browser opens `github.com/lloyal-ai/reasoning-run/issues/new` prefilled with the message + Environment block; the panel shows the URL and "Enter to close".
3. Confirm the issue body contains the Environment section (version, OS, CPU, GPU) and your message; confirm **no** issue is created until you click Submit in the browser.
4. Esc at any step returns to the normal composer.

Expected: browser opens with a prefilled, reviewable issue; Esc/Enter navigation works; the query field returns after close.

- [ ] **Step 8: Commit**

```bash
git add src/tui-ink/components/Composer.tsx
git commit -m "feat(tui): wire /feedback command into the composer"
```

---

## Post-implementation (not code)

- **Optional:** create a `feedback` label on `lloyal-ai/reasoning-run` (repo → Issues → Labels) so `?labels=feedback` tags land; harmless if skipped.
- **PR:** push `feat/feedback-slash-command` and open a PR into `main`.

## Self-Review notes

- **Spec coverage:** destination/mechanism (Task 5 + Task 3 browser open), scrubbed errors (Task 2 `scrubError` + Task 4 consent), env block incl. `LLOYAL_GPU` (Task 1 + Task 3), reset survival (Task 1 Step 5 + tests), encoded URL cap with errors-first then message truncation (Task 2 `buildFeedbackBody`), per-platform open incl. Windows `cmd /c start ""` (Task 3), durable URL via panel "opened" step (Task 4). All spec sections map to a task.
- **Mounting:** Composer-local, no new `uiPhase` (matches inline-editor precedent); `Field` union untouched (panel owns its input) — resolves review findings #1/#2.
- **Type consistency:** `EnvMeta`/`ErrorRecord` defined in Task 1 and consumed unchanged in Tasks 2/3/4; `open_feedback` defined in Task 3 and dispatched in Task 4; `buildFeedbackBody`/`buildIssueUrl`/`feedbackTitle`/`scrubError` signatures defined in Task 2 and called with matching args in Task 4.
- **Field-name caveat:** Task 4 Step 2 / Task 2 reference `config.model.path`, `config.model.reranker`, `config.sources.corpusPath`, `config.sources.outputDir` — verify against `ConfigModel`/`ConfigSources` in `src/tui-ink/config.ts` during implementation and correct if the property names differ.
