# Design: `/feedback` slash command for reasoning.run

**Date:** 2026-06-22
**Status:** Approved (design) — pending implementation plan
**Component:** `reasoning.run` TUI (Ink)

## Problem

reasoning.run has no channel for users to tell us how it went or to report the
errors they hit. The tool is fully local and privacy-first — there is no backend,
telemetry, or crash reporting today. We want a `/feedback` command that lets a user
send us their experience and, **with explicit consent**, the errors that occurred
during their session.

## Decisions (locked)

| Question | Decision | Why |
|---|---|---|
| Where feedback lands | **GitHub issue** on `lloyal-ai/reasoning-run` | Founder's call. Issues carry version/hardware, are public-by-design (builds GitHub activity), and need zero hosted infra/spend. |
| How the issue is filed | **Prefilled browser URL** (`issues/new?title=…&body=…&labels=…`) | No token shipped, no backend. Consent is intrinsic: the user sees the full issue and clicks **Submit** under their own GitHub account. |
| Error payload | **Scrubbed: messages only** | The destination is a *public* issue. Strip query text and corpus content; never attach the full trace. |
| Consent | Two gates: an in-TUI `[y/N]` for attaching errors, and the browser submit click itself | "Take consent before sending" — nothing leaves the machine until the user clicks Submit in their browser. |

## User experience

New slash command `/feedback`, registered in the existing `COMMANDS` array
(alongside `/web`, `/model`, …):

- `/feedback <message>` — opens the panel pre-filled with `<message>`.
- `/feedback` — opens the panel with an empty message field.

`/feedback` does **not** reuse the `Field` inline-editor union (see Architecture —
the panel owns its own text input, so `Composer.tsx`'s closed `Field` union is left
untouched). `handleSlash` instead flips a Composer-local `feedback` flag.

Once open, a guided panel (`FeedbackPanel`, a Composer-local overlay modeled on the
existing inline editors) runs the flow:

0. **Message field** (step 0): single-line input, pre-filled if a message was passed
   inline. Enter advances; Esc cancels and returns to the composer.

1. **Message captured.**
2. **If the session recorded ≥1 error** → prompt:
   *"Attach N error(s) from this session? They'll appear in a **public** GitHub issue. `[y/N]`"*
   — **default No**.
3. **Open confirm:** *"Open a prefilled GitHub issue in your browser to review & submit? `[Y/n]`"*
4. On confirm → open
   `https://github.com/lloyal-ai/reasoning-run/issues/new?labels=feedback&title=…&body=…`.
   The browser shows the issue **fully prefilled**; the user reviews everything and
   clicks **Submit new issue**. Nothing is transmitted until that click.

If no error occurred this session, step 2 is skipped.

## Issue contents

- **Title:** `Feedback: <first ~60 chars of message>`
- **Label:** `feedback` (create once on the repo).
- **Body:**
  - The user's message.
  - `## Environment` *(auto, non-sensitive)*:
    - `reasoning.run` version (`pkg.version`)
    - OS platform + arch (`os.platform()`, `os.arch()`)
    - CPU model string (`os.cpus()[0].model`) — the practical **AVX-512 signal**,
      which ties directly into the open `lloyal.node` 3.0.0 AVX-512 regression
    - Node version
    - GPU mode — read from the **`LLOYAL_GPU` env var** (`cuda` / `vulkan` / `metal`
      / `cpu`), **not** config (config has no GPU field); fall back to `unknown` when
      unset
    - Model + reranker **basename only** (not full paths)
    - Reasoning mode (`deep` / `flat`)
  - `## Errors (N)` *(only if the user consented in step 2)*: one scrubbed line per
    captured error.

## Architecture

A self-contained `FeedbackPanel` Ink component owns the interaction. It reads from
`AppState` only (`config`, the new `errors` buffer, a new `env` meta block), composes
the issue body and URL with **pure helper functions**, and dispatches a single
side-effecting command. `main.ts` performs only the OS-level browser open.

This keeps all body/URL/scrub logic pure and unit-testable and confines side effects
to one command — matching the repo's existing "UI renders from state; side effects
go through the command boundary" model (`commands.ts` header comment).

### Mounting — Composer-local, no new `uiPhase`

The repo's existing inline editors (`/web`, `/scan`, `/model`, …) are handled
**entirely in `Composer.tsx` local state** (`field`/`draft` `useState`) — they render
in place of the query field while `uiPhase` stays `composer`/`done`, and they do
**not** round-trip through `main.ts` or the reducer. `/feedback` follows that same
precedent rather than introducing a `uiPhase: 'feedback'` (which would force a
`command → main.ts → event` round-trip that the UI-only flow doesn't otherwise need):

- `handleSlash` sets a Composer-local `feedback` state (`{ message: string } | null`),
  pre-filled from any inline `<message>`.
- While `feedback !== null`, Composer renders `<FeedbackPanel>` in place of the query
  field (exactly where the `/web`-style editors render), passing `errors`, `env`,
  `config`, the initial message, the `dispatch`, and an `onClose` callback.
- `FeedbackPanel` owns its **own** single-line `TextInput` for the message (step 0)
  and its own step state (message → error-consent → open-confirm). The closed `Field`
  union and the `commitX` handlers in `Composer.tsx` are **left untouched**.
- Cancel/Esc at any step calls `onClose()` → Composer clears `feedback` → query field
  returns. After a successful open, `onClose()` likewise returns to the composer.

### State additions (`state.ts` + `reducer.ts`)

`errors` and `env` live on `AppState` (the reducer is the only place that sees
`ui:error`/`boot:error`), even though the panel itself is Composer-local.

- **`errors` buffer**: a capped (≈20, FIFO) array on `AppState`. The reducer appends
  to it in the **existing** `ui:error` and `boot:error` cases — no new error plumbing,
  no new event types. Each entry: `{ message: string; kind?: 'llm' | 'reranker'; at: number }`.
  - Note: `ui:error`/`boot:error` events currently carry only `message` (and `kind`
    for boot) — **not** stack traces (stacks live in `main.ts` via `errorStack` and
    are not propagated through the event stream). v1 captures the message strings as
    surfaced to the user (e.g. `"createContext() → STATUS_ILLEGAL_INSTRUCTION …"`,
    `"Research failed: …"`, `"Cannot use <path>: …"`). *Optional later extension:* add
    an optional `detail`/stack field to `ui:error` if richer diagnostics are wanted.
  - **Survival across resets (critical):** `reducer.ts` resets to `...initialState` on
    `case 'query'` (~line 250) and `case 'preflight:start'` (~line 486), preserving
    only `config`, `scrollback`, `participation`. **`errors` and `env` MUST be added
    to both preserve-lists**, or errors from one query vanish the moment the next
    query starts — making the buffer near-useless. This is a required implementation
    step, tested explicitly (below).
- **`env` meta**: a small object assembled once at config-load (`config:loaded`) and
  carried on `AppState`, holding the non-sensitive Environment fields above. Also
  preserved across the resets above. GPU is sourced from `process.env.LLOYAL_GPU`
  (see Issue contents).

### Command boundary (`commands.ts` + `main.ts`)

- New command: `{ type: 'open_feedback'; url: string }`.
- `main.ts` handler: open the URL with the platform opener, **per-platform precisely**
  (no new dependency):
  - macOS: `spawn('open', [url])`
  - Linux: `spawn('xdg-open', [url])`
  - Windows: `spawn('cmd', ['/c', 'start', '', url])` — `start` is a `cmd.exe`
    builtin, so it **cannot** be spawned directly (`spawn('start', …)` ENOENTs); the
    empty `''` is the required title arg.
  - Spawn detached, `unref()`, and swallow the child's own errors.
- **On opener failure**, the URL must stay visible (a transient `ui:error` toast is
  not adequate for a long, copyable URL — #7). Emit a durable **scrollback** entry
  (the `Static`/scrollback channel, not the toast) containing the full URL with a
  "couldn't open browser — copy this URL" note.

### New module (`feedback.ts`) — pure, tested

- `scrubError(message, ctx): string` — **best-effort** redaction (see Privacy note in
  the scrubbing section; this cannot *guarantee* corpus content is absent).
- `buildFeedbackBody({ message, env, errors, includeErrors }): string` — render the
  Markdown body described above.
- `buildIssueUrl({ title, body, label }): { url: string; truncated: boolean }` —
  URL-encode and assemble the `issues/new` URL, enforcing the **encoded**-length cap
  (below) and reporting whether truncation occurred.

### Files touched

| File | Change |
|---|---|
| `src/tui-ink/components/Composer.tsx` | Register `/feedback` in `COMMANDS`; `handleSlash` flips a local `feedback` state and conditionally renders `<FeedbackPanel>`. `Field` union untouched. |
| `src/tui-ink/components/FeedbackPanel.tsx` | **New.** Composer-local overlay; owns message input + consent steps; reads `errors`/`env`/`config` from props; dispatches `open_feedback`; `onClose` returns to composer. |
| `src/tui-ink/feedback.ts` | **New.** Pure `scrubError` / `buildFeedbackBody` / `buildIssueUrl`. |
| `src/tui-ink/commands.ts` | Add `open_feedback` to the `Command` union. |
| `src/tui-ink/state.ts` | Add `errors` buffer + `env` meta to `AppState` + `initialState`. |
| `src/tui-ink/reducer.ts` | Append to `errors` in existing `ui:error`/`boot:error` cases; **preserve `errors` + `env` in the `query` and `preflight:start` reset branches**; seed `env` at `config:loaded`. |
| `src/main.ts` | Handle `open_feedback` (precise per-platform open + failure scrollback); provide `LLOYAL_GPU`/version for `env` seeding. |

## Privacy & scrubbing (best-effort, honestly scoped)

The destination is a **public** issue, so we minimise what an error line can leak —
but because an error `message` is an arbitrary string, scrubbing is **best-effort, not
a guarantee.** `scrubError` applies this concrete redaction set:

1. Absolute **POSIX** paths (`/…`) → basename.
2. Absolute **Windows** paths (`C:\…`, UNC `\\…`) → basename.
3. The user's **home directory** → `~`.
4. The configured **model / reranker / corpus / output** paths → basename/redacted.
5. The session's **current query** string, if present.
6. **URL query strings** (`?…`) stripped (may carry keys/search terms).
7. Each error length-bounded.

We never attach the full trace. The real guarantee is the **consent + review** model:
the user sees the exact issue body in their browser and clicks Submit themselves — so
the spec claims *best-effort redaction + user review*, **not** an absolute "no corpus
content" promise.

## Edge cases

- **URL length (encoded):** GitHub prefilled URLs are capped (~8 KB). The cap must be
  enforced on the **percent-encoded** URL length, not raw chars (a raw 6 KB body can
  exceed 8 KB once encoded; multibyte/quotes expand). `buildIssueUrl` builds the
  encoded URL and, if over the limit, trims in this order: (1) drop/truncate the
  `## Errors` section with `(truncated)`; (2) if message + Environment **alone** still
  exceed the limit, truncate the **user message** with a visible `…(truncated)` marker
  and keep Environment. It returns `{ url, truncated }`; when `truncated`, the panel
  warns the user before opening ("message was shortened to fit GitHub's URL limit").
- **Headless / opener failure:** emit a **durable scrollback** entry (not the transient
  toast) holding the full URL so the user can copy it. (See Command boundary, #7.)
- **No GitHub account:** acceptable — reasoning.run's audience is developers; the
  prefilled page still renders and prompts them to sign in. No fallback path in v1.
- **No errors this session:** skip the error-consent step entirely.

## Testing

Two layers. **Pure helpers** in a new `src/tui-ink/__feedback-smoke.ts`, and
**reducer behaviour** added to the existing `src/tui-ink/__reducer-smoke.ts`
(both wired into the `smoke` script in `package.json`).

Pure (`feedback.ts`):
- `scrubError` redacts POSIX + Windows paths to basenames, home dir → `~`, configured
  model/corpus/output paths, and the session query string.
- `buildFeedbackBody` snapshot for: (a) message only, (b) message + scrubbed errors.
- `buildIssueUrl` encodes correctly; enforces the **encoded**-length cap — errors
  truncated first, then message, with Environment always intact; reports `truncated`.

Reducer (`reducer.ts`):
- `ui:error` and `boot:error` **append** to the `errors` buffer and respect the FIFO
  cap (oldest dropped past ≈20).
- `query` and `preflight:start` resets **preserve** `errors` and `env` (regression
  guard for finding #3).
- `config:loaded` seeds `env`.

## Out of scope (YAGNI)

- Multi-line feedback editor.
- Ratings / categories / structured forms.
- Direct GitHub API submission (token or `gh` CLI path).
- Persisting a consent preference across sessions.
- Attaching the full session trace (`trace-*.jsonl`).
- A bot account / shipped token.

## Risks / follow-ups

- The `feedback` label must exist on `lloyal-ai/reasoning-run` or GitHub silently
  drops the `labels=` param — create it as a one-time repo setup step.
- CPU model string is a *proxy* for AVX-512 capability, not a definitive flag.
  Precise per-feature detection (sysctl / `/proc/cpuinfo`) is a possible later
  enhancement if the regression triage needs it.
- **Mounting decision (vs. external review #1):** the panel is Composer-local rather
  than a new `uiPhase: 'feedback'`. This matches the existing inline-editor precedent
  and avoids a UI→`main.ts`→event round-trip for a UI-only flow. If a future step
  needs the panel to survive a query/research phase change, revisit and promote it to
  a real `uiPhase` then (YAGNI for v1).

## External review incorporated (Codex, 2026-06-22)

All eight findings verified against source and folded in: panel mounting made explicit
(Composer-local; §Mounting), `Field` union left untouched (panel owns its input),
`errors`+`env` preserved across the `query`/`preflight:start` resets (§State, tested),
privacy claim softened to best-effort with a concrete redaction list (§Privacy),
URL cap enforced on encoded length with message-too-long handling (§Edge cases),
precise per-platform browser open incl. Windows `cmd /c start "" <url>` (§Command
boundary), durable scrollback for opener failure instead of a transient toast, and
GPU sourced from `LLOYAL_GPU` rather than a non-existent config field.
