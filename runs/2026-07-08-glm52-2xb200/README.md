# GLM-5.2 deep-research runs — 2× B200, 2026-07-08

Field notes and raw artifacts from two `reasoning.run` deep-research runs of **GLM-5.2**
(unsloth `UD-IQ2_M`, ~239 GB, arch `glm-dsa`, a 744B-class MoE) served on **one deployment
of 2× NVIDIA B200** on RunPod. Same model, same weights, same corpus — the two runs differ
only in fan-out width (up to 6 concurrent research agents vs. 10) and are published here so
the numbers in the write-up can be checked against the actual trace, config, and reports.

These back the "part you can check" in the post
**"Shifting the harness left"** — https://docs.lloyal.ai/blog/shifting-the-harness-left
(that link goes live when [lloyal-ai/hdk-docs#5](https://github.com/lloyal-ai/hdk-docs/pull/5)
merges).

## What ran

Both runs are the same deep-research task: **Deep Research Bench Task 51 — the market size
and growth outlook of Japan's elderly-care industry**, over a preloaded 18–19 document corpus
(`corpus-task51`). GLM-5.2 plans the task, fans out into parallel research agents on one live
context, and synthesizes a single cited report plus one annexure per agent.

- **`six-agent/`** — the general Task 51 question. Up to **6 research agents** ran
  concurrently; the run wrote a synthesized report plus **5 per-agent annexures**.
- **`ten-agent/`** — a 10-segment rewrite of the same question (one Japanese care sub-market
  per agent), run at `--effort ultra` to widen the fan-out to **10 agents**.

## Receipts

| | six-agent | ten-agent |
|---|---|---|
| Deployment | 2× NVIDIA B200 (Blackwell, sm_100), RunPod | 2× NVIDIA B200 (Blackwell, sm_100), RunPod SECURE, EU-RO-1 |
| Model | GLM-5.2 unsloth `UD-IQ2_M` (~239 GB, `glm-dsa`) | GLM-5.2 unsloth `UD-IQ2_M` (~239 GB, `glm-dsa`) |
| Engine | `reasoning.run` 0.5.0 · `lloyal.node` 3.1.1 · Node 24.18.0 | `reasoning.run` 0.5.1 (`feat/ultra-effort-slider`) · `lloyal.node` 3.1.1 · Node 24 |
| Fan-out | up to 6 concurrent research agents | `--effort ultra` → `maxTasks: 10`, `reasoningMode: flat`, `nCtx: 131072` |
| Report | 30.7 KB · 6 sections + 5 annexures · 6,775 synthesis tokens · ppl 1.12 | 33.5 KB · 8 annexures (agents 1 and 5 returned no findings — no annexure written) |
| Runtime | ~43 min end-to-end (synthesis elapsed 2,576.9 s) | 82.4 min end-to-end (pod created 13:38:34 UTC, torn down ~15:01 UTC) |
| KV context | peaked at 39% of a 131k window and settled back | drained cleanly at wrap-up (93% → 21%) |
| Cost | ~$17 for the pod session (2× B200; multiple attempts + capture) | ≈ $16.18 compute — 1.374 h × $11.78/hr ($5.89/GPU/hr × 2); pod `i5nz4wt9i2hmzw` |

The backend was served by the 0.5.x **backend pack** (`--backend-pack download`): the pod
probed the GPUs, pulled a signed pack, and loaded native Blackwell (sm_100) CUDA kernels — no
local rebuild. Boot line: `load_backend: loaded CUDA backend from
~/.cache/lloyal/backends/3.1.1-linux-x64/libggml-cuda.so`. Both cards loaded the model
(≈114 / 118 GB VRAM).

## Honest labels — read these before quoting anything

- **One deployment, not one GPU.** Every run here is on **2× B200** (360 GB total). "One
  deployment" means one model instance / one live KV context that the agents branch off — it
  does **not** mean one card. Don't quote these as a single-GPU result.
- **Corpus + live web, not zero-egress.** Keyless web search was **ON** alongside the
  preloaded corpus in both runs. Describe the setup as "corpus + live web." Do not caption it
  "zero egress" or "corpus-only."
- **The ten-agent fan-out was 6 planner-generated + 4 added by hand.** The stock ultra planner
  returned 6 tasks for this query; segments 7–10 (care robotics, ICT/telecare, LTCI financing,
  private insurance) were added in the plan editor to reach 10. Ultra supports up to 10 — but
  the planner did not autonomously choose 10.
- **The ten-agent trace was not retained.** The pod was torn down before the structured
  `trace-*.jsonl` / run-event stream was pulled, and it is gone with the pod volume. What
  survives for that run is the report, the annexures, and the cost receipt above — that's why
  `ten-agent/` has no trace file. The live capture GIF of the 10-column fan-out lives in the
  blog post, not in this repo. (The six-agent run has its full trace.)
- **Citations are end-of-document, not inline.** Both reports carry a proper Sources list but
  no in-text `[title](url)` links. These runs demonstrate the harness and orchestration; they
  are not a scored Deep Research Bench submission.

## Layout

```
six-agent/          # the complete bundle — the substance run
  trace-2026-07-07T23-36-40-611.jsonl   # full structured run trace (WorkflowEvent stream)
  report.md                             # the synthesized report
  annexure-1.md … annexure-5.md         # one per research agent
  config.lloyal-pack.json               # the signed backend-pack manifest for this run
  pod-facts.txt                         # nvidia-smi, node/npm versions, backend cache listing

ten-agent/          # report + annexures + cost receipt (trace not retained — see above)
  report.md
  annexure-2.md, -3, -4, -6, -7, -8, -9, -10   # one per agent that returned findings
```

The trace is line-delimited JSON: line 1 opens the root scope, each subsequent line is one
event (`branch:create`, `prompt:format`, `tool:*`, `branch:prefill`, …). The synthesis event
carries `"tokenCount":6775`, matching the `6775 synthesis tokens` in `six-agent/report.md`.

## Provenance

Every file in this directory was scanned for secrets (API keys, tokens, credentials, private
URLs/IPs, emails) before publishing. **No secrets were found and nothing was redacted** —
`config.lloyal-pack.json` and `pod-facts.txt` contain only file hashes, versions, and
hardware facts; the trace contains only the run's own events. The model/GPU identity for the
ten-agent run is evidenced separately (the trimmed capture casts drop the boot logs).
