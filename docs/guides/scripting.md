# Scripting & CI

**What this covers:** running reasoning.run non-interactively — no TUI, no prompts — so you can drive it from a script, a CI job, or a pipeline. You pass the question on the command line, get machine-readable output, and choose where the report bundle lands.

## When there's no terminal, `--query` is required

Normally you launch `npx reasoning.run`, the TUI opens, and you type your question. In a script or CI job there's no interactive terminal (no TTY), so there's nothing to type into. In that case you must supply the question up front with `--query`:

```bash
npx reasoning.run --query "What changed in the EU AI Act in 2026?"
```

`--query` is **required** whenever reasoning.run is not attached to a TTY, and also whenever you pass `--jsonl` (which turns off the TUI even in a terminal). If it's missing in a non-interactive run, reasoning.run prints `Non-TTY mode requires --query.` to stderr and exits.

`--query` runs the full pipeline once — plan, research, synthesize — with no approval step, then exits. The planner does **not** pause for you to edit the plan (there's no one to edit it). If the planner decides it needs to ask a clarifying question, a non-interactive run can't answer, so it aborts with a message on stderr rather than hanging.

> You also need a research source configured, or the run has nothing to work with. In headless mode reasoning.run never prompts you to download or pick one — set `TAVILY_API_KEY`, pass `--corpus <dir>`, or store a source in `harness.json` first. Without one it prints `No source configured.` to stderr and exits. See [research the web](./research-the-web.md) and [research your files](./research-your-files.md).

## Machine-readable output with `--jsonl`

`--jsonl` streams the run as newline-delimited JSON events on stdout instead of drawing the TUI — one JSON object per line, suitable for piping into another program or a log collector:

```bash
npx reasoning.run --query "Summarize our Q3 competitor moves" --jsonl
```

Because `--jsonl` disables the TUI, it implies the non-interactive path above — so `--query` is required alongside it.

## Choosing where files land with `--output-dir`

Every run still writes its report bundle to disk (the `--jsonl` stream is in addition to, not instead of, the files). By default the bundle lands under the current working directory. Point it somewhere predictable — a build artifacts folder, a mounted volume — with `--output-dir`:

```bash
npx reasoning.run --query "..." --output-dir ./out
```

For exactly what gets written and how the directory is laid out, see [outputs & replay](./outputs-and-replay.md).

## Exit behavior

reasoning.run has **no `--help` and no `--version`** — an unrecognized or invalid argument prints a targeted message to stderr and exits non-zero. In a script, check the exit code and capture stderr:

- Invalid argument values (e.g. a bad `--reasoning-mode` or `--gpu`) exit `1`.
- Headless preconditions that aren't met — missing `--query`, no source configured, or a clarifying question the run can't answer — print to stderr and exit `2`.

Always inspect stderr on a non-zero exit; that's where the reason is written.

## A CI / pipeline example

Put it together — supply the question, stream JSONL, and collect the bundle in a known folder:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Node >=24 is required. A source must be configured — here, Tavily via env.
export TAVILY_API_KEY="$TAVILY_API_KEY"

npx reasoning.run \
  --query "What are the top 3 risks in our 2026 supply chain?" \
  --jsonl \
  --output-dir ./out \
  > run.jsonl

# The cited report and per-agent annexures are now under ./out — see below.
ls -R ./out
```

The report bundle (`report.md`, per-agent annexures, and the trace) is in `./out`. See [outputs & replay](./outputs-and-replay.md) for the exact layout and how to replay a past run.

## See also

- [CLI reference → Flags](../cli-reference.md#flags) — full detail on `--query`, `--jsonl`, `--output-dir`, and every other flag.
- [CLI reference → Environment variables](../cli-reference.md#environment-variables) — `TAVILY_API_KEY` and friends.
- [Outputs & replay](./outputs-and-replay.md) — what a run writes and how to replay it.
- Prerequisites, including the **Node >=24** requirement, are in [Getting started → Prerequisites](../getting-started.md#prerequisites).
