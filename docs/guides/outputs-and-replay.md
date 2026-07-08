# Outputs and replay

**What this covers:** where reasoning.run writes your reports and traces on disk, how to work with those plain files (grep, diff, share), and how to re-run a past research run from its trace with `--replay-trace`.

Every run writes ordinary files to a folder on disk — nothing is hidden in a database. That makes the output easy to read, search, diff, commit to git, and hand to a teammate.

## Where files land

When you ask a question, reasoning.run writes the answer under your **output directory** — the current working directory by default, or wherever you point [`--output-dir`](../cli-reference.md#flags) (or [`sources.outputDir`](../configuration.md#keys) in `harness.json`).

Inside the output directory you get two kinds of thing:

- **One folder per question** — named by an ISO timestamp (colons and dots become `-`), e.g. `2026-07-08T09-15-31-004/`. Each holds:
  - **`report.md`** — the synthesized, cited answer. It opens with your question and a metadata line, then the answer, then an "Annexures" list linking to the per-agent files.
  - **`annexure-N.md`** — one file per research agent, numbered in the order the agents spawned. Each is that agent's raw findings for its slice of the plan.
- **One `trace-<timestamp>.jsonl` at the output-directory root** — a **trace** is a line-by-line JSON log (one JSON object per line, hence `.jsonl`) of every event in the run: planning, tool calls, agent returns, synthesis. It sits *beside* the timestamp folders, not inside them, because it is **per session (per process)**: a single interactive session that answers several questions writes several timestamp folders but just **one** trace file that captures them all.

A directory after one session with two questions looks like this:

```
./                                       ← your output dir (defaults to the current directory)
├─ trace-2026-07-08T09-15-30-421.jsonl   ← one per session, at the root
├─ 2026-07-08T09-15-31-004/              ← first question
│  ├─ report.md                          ← the cited answer
│  ├─ annexure-1.md                      ← agent 1's findings
│  └─ annexure-2.md                      ← agent 2's findings
└─ 2026-07-08T09-42-12-988/              ← second question, same session
   ├─ report.md
   └─ annexure-1.md
```

> If a run fails partway through, its annexures are still written but `report.md` is not — so a folder with annexures and no report is a run that did not finish. The trace still captures whatever happened, since it is written live.

## Working with the artifacts

Because everything is plain Markdown and JSONL, you use your normal tools:

```bash
# Find every report that mentions a term
grep -ril "interest rate" ./

# Compare two runs of the same question
diff old-run/report.md new-run/report.md

# Skim a trace's event stream (each line is one JSON object)
jq -r '.type' ./trace-2026-07-08T09-15-30-421.jsonl | sort | uniq -c
```

Share a result by sending the `report.md` (and its `annexure-*.md` if the reader wants the raw findings). Keep a trace if you might want to replay it later.

For running non-interactively and choosing where output lands in CI, see [scripting.md](./scripting.md).

## Replaying a past run — `--replay-trace`

`--replay-trace <path>` re-runs a research session starting from a saved trace, instead of from a question you type:

```bash
npx reasoning.run --replay-trace ./trace-2026-07-08T09-15-30-421.jsonl
```

reasoning.run reads the trace up front (failing loudly if the file is missing or malformed), reconstructs the run's pre-research starting point, recovers the original question from it, and re-runs from there. Replay always runs **one-shot with JSONL output and no interactive TUI** — the flag forces that mode, so you get machine-readable events just as with [`--jsonl`](../cli-reference.md#flags).

**The main use is comparison and regression.** Because replay pins only the *starting point* of the run, you can change other flags and see how the run differs from the same seed — for example, swap in a different model or reranker and compare the reports:

```bash
# Same starting point, different model — compare report.md against the original run
npx reasoning.run --model ./other-model.gguf --replay-trace ./trace-2026-07-08T09-15-30-421.jsonl
```

You can also override the recovered question with [`--query`](../cli-reference.md#flags) if you want to run a different ask from the same seed.

**Two things to know:**

- **Replay is not bit-for-bit.** The reconstructed starting state is exact, but the sampler's randomness is not captured, so the agents' choices *after* the seed can diverge from the original run. That is fine for the intended use (comparing rerank/report quality across configs); it is not a way to reproduce an identical transcript.
- **Older traces may not replay.** Replay needs a starting-point checkpoint that only recent versions record in the trace. If you point it at a trace that predates that, you get a clear error explaining the trace lacks the seed event — capture a fresh trace with this version and replay that instead.

---

For the full flag list (`--replay-trace`, `--output-dir`, `--jsonl`) see the [CLI reference](../cli-reference.md#flags); for the `sources.outputDir` config key see [configuration](../configuration.md#keys).
