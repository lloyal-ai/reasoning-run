# How a run works

*What this covers: the shape of a reasoning.run session — how your question becomes a cited report — and every control you have along the way.*

A run is a short loop you stay in the driver's seat for:

```
you ask  →  the planner decomposes the question into tasks  →  you approve (and edit) the plan
         →  research agents work the tasks in parallel  →  the synthesizer writes one cited report
```

- **Planner** — reads your question and proposes a short task list.
- **Research agent** — one worker per task; it searches, fetches, and reasons to gather findings.
- **Synthesizer** — folds every agent's findings into a single `report.md` with citations.

You approve the plan before any agent runs, you can steer things while they run, and you get plain Markdown files at the end. The rest of this page walks the loop and names the key for each control.

> The full keyboard cheat-sheet lives in the [interactive controls](../cli-reference.md#interactive-controls) table — this page explains *when* you'd reach for each one.

## Two ways to start

When you type a question, the submit button shows **PLAN** or **START**. `Shift+Tab` toggles between them; `Enter` fires whichever is focused.

- **PLAN → a planned run.** The planner breaks your question into tasks and shows you the plan to review and edit. When you're happy, you launch it. This is the default and what you want for anything non-trivial.
- **START → a direct ask.** Skips the planner entirely and runs a single agent for a quick, direct answer. Good for a simple lookup where a full multi-agent plan would be overkill.

The rest of this page assumes the **PLAN** path, since that's where the controls live.

## Review and edit the plan

Once the planner returns, you land in the plan review with a list of proposed tasks. Nothing runs yet — this is your chance to shape it. Move with `↑`/`↓` (`↓` steps down onto the **START** button below the list):

| Key | Does |
|---|---|
| `↑` / `↓` | Move between tasks (and the START button) |
| `⏎` | Edit the focused task's text (or, on the START button, launch the run) |
| `A` | Add a new task after the focused one |
| `D` | Delete the focused task (only if more than one remains) |
| `⇧↑` / `⇧↓` | Reorder — move the focused task up or down |
| `Esc` | Discard the plan and go back to your question |

When the plan looks right, move down to the **START** button and press `⏎` to launch it.

## Clarify rounds

Sometimes the planner doesn't have enough to go on and answers with a follow-up question instead of a plan. Type your answer and submit it — the planner re-plans with the extra context. You may go through a couple of these clarify rounds before you get a task list to approve. This is normal and makes the eventual report sharper.

## Choose what the agents use

Your run draws on **sources** — the web, and optionally a **corpus** (a folder of your own local files; see [Research your files](./research-your-files.md)). Each source shows as a chip. `Tab` moves focus to a chip; **`Space`** toggles that source's participation on or off for the run, and `⏎` opens its configuration. Turn the web off for a corpus-only, offline run; leave it on to let agents search live. See [Research the web](./research-the-web.md) for the web source and the optional Tavily key.

## Flat vs deep

Two reasoning modes shape *how* the agents work:

- **flat** (the default) — agents work in parallel, each on its own task, then the synthesizer folds them together. Fast and broad.
- **deep** — a chained, sequential style that goes further on a single line of reasoning.

Switch modes with the `/deep` and `/flat` slash commands, or toggle the mode with `T` while reviewing a plan. (For the physics of why parallel agents fit in one context, see [under the hood](#under-the-hood).)

## Effort

**Effort** sets how hard a run works — how much retrieval headroom and report budget each agent gets. There are four tiers:

`low` · `medium` · `high` · `ultra` — **default `high`**.

Set it two ways:

- **Live, in the TUI:** run the **`/effort`** slash command to open an interactive slider, pick a tier, and press `⏎`. It applies to this and every following query in the session.
- **As a session default:** set `defaults.effort` in `harness.json` (see [configuration keys](../configuration.md#keys)).

There is **no `--effort` command-line flag** — those are the only two ways to set it.

> **`ultra` is the calibration-unstable max tier.** It's the newest, most aggressive preset and, per the source, "unproven, worth a real run to calibrate." Reach for it deliberately, not as a default. (`low`/`medium` are likewise starting estimates that may shift.) `high` reproduces the historically-tuned values and is the safe choice.

## While the agents work

Once a run is launched, the submit pill becomes a run control. Watch the agents **stream** their progress live — each research agent gets its own card with a running status. You have three ways to intervene:

- **WRAP UP** *(the default; `Enter`)* — graceful drain. The pool stops spawning new work, lets in-flight agents and tool calls settle, then folds whatever's been gathered into a recovered answer and synthesizes it. Use this when you have enough and just want the report now, without throwing away work.
- **STOP** *(`Tab` to it, then `Enter`)* — abort. Tears the run down and drops you back at the composer with no report. It's deliberately a `Tab`-then-`Enter` so you can't discard a run by reflex.
- **Cancel one agent** *(number keys `1`–`9`)* — in **flat** mode with more than one agent live, press an agent's badge number to discard just that one research agent; its siblings keep running. Handy when a single task has clearly gone off track but the rest are fine.

When the synthesizer finishes, `report.md` (plus a per-agent `annexure-N.md` for each task) is written under your output directory. See [Outputs and replay](./outputs-and-replay.md) for exactly where the files land and how to replay a past run.

## Under the hood

The reason five research agents can share one 32K-token context — and why a follow-up question in the same session is instant — is HDK's **Continuous Context**: agents share GPU KV state instead of re-tokenizing strings. That's engine-level machinery this guide deliberately doesn't re-teach. For the full story, read [Continuous Context](https://docs.lloyal.ai/under-the-hood/continuous-context-spine) on docs.lloyal.ai.
