# Getting started

**What you'll do:** go from a clean machine to your first cited report — install, run one command, ask a question, approve a plan, and read the answer the agents write to disk.

reasoning.run is a private reasoner for your terminal: it runs a small team of research agents fully on your own machine (no API keys, no inference server) and writes a cited report to a plain Markdown file.

## Prerequisites

- **Node.js ≥ 24 — required.** This is a hard floor. On an older Node the CLI fails to start with a cryptic error; check with `node --version` and upgrade first if you're below 24. (If you hit this, see [Troubleshooting](./troubleshooting.md).)
- **~3 GB free disk and a network connection for the first run only.** The first run downloads the default models (~3 GB, see [First run](#first-run) below). Once they're cached, every later run is fully offline — no network needed.
- **Memory: 16 GB recommended · 12 GB minimum** (default 4B model). The default setup — a 4B model with a shared 32K-token context — runs comfortably at 16 GB (the demo is a 16 GB MacBook); 12 GB is the supported minimum, and larger models or context windows need more. With a discrete GPU the model loads into VRAM (the default needs only a few GB); otherwise it uses system RAM.

**Operating systems and GPUs:**

- **macOS on Apple Silicon (M-series):** the GPU (Metal) is used **automatically** — there is no flag to set, and `--gpu metal` is deliberately rejected.
- **macOS on Intel (x64):** runs CPU-only.
- **Linux:** select a GPU backend with `--gpu cuda` or `--gpu vulkan` (or omit it for the platform binary's built-in backend). To run on datacenter / frontier-class cards, see the backend-pack path in the [models & GPU guide](./guides/models-and-gpu.md).
- **Windows:** supported — select a GPU backend with `--gpu cuda` (NVIDIA) or `--gpu vulkan` (other GPUs), or omit it for the platform binary's built-in backend. As on Linux, use the backend-pack path for datacenter-class CUDA cards ([models & GPU guide](./guides/models-and-gpu.md)).

The flags, env vars, and their precedence live in one place — the [CLI reference](./cli-reference.md#flags). This page doesn't restate them.

## Install & run

There's nothing to install globally. Run it straight from npm:

```
npx reasoning.run
```

That launches the interactive terminal UI (TUI). The command takes no subcommands.

## First run

**1. Models download once.** On the very first launch reasoning.run fetches its two default models — an LLM and a reranker — and caches them under `~/.cache/lloyal/models/`:

| Model | Role | Format |
|---|---|---|
| Qwen3.5-4B Q4_K_M | the LLM that reasons and writes | `.gguf` |
| Qwen3-Reranker 0.6B Q8_0 | scores retrieved chunks for relevance | `.gguf` |

*(`.gguf` is the on-disk file format for a local model. A **reranker** is a small model that ranks search results so the most relevant chunks reach the agents.)* Together they're ~3 GB. This download happens **once**; after it, launches are offline and near-instant.

If the download fails partway (flaky network, mirror hiccup), you can point at a local model file to continue — see [Troubleshooting](./troubleshooting.md).

**2. Ask a question.** When the TUI appears, type a research question into the composer and submit it.

**3. Plan → edit → START.** A small planner decomposes your question into research tasks and shows you the plan in an editor. Nothing runs until you approve it:

- Navigate tasks with `↑` / `↓`, edit one with `⏎`.
- Add, delete, or reorder tasks (`A` / `D` / `⇧↑↓`).
- When the plan looks right, press **START**.

*(You can also skip the planner for a quick single-agent answer, and switch between flat and deep reasoning. The full control set is in the [how-a-run-works guide](./guides/how-a-run-works.md).)*

**4. Watch the agents work.** Several research agents run in parallel, streaming their progress. You can let them finish, stop the run, or wind it down gracefully — again, see the [how-a-run-works guide](./guides/how-a-run-works.md).

**5. Read your report.** When the run finishes, the synthesized answer is written to `report.md` inside a timestamped folder under the directory you launched from (each agent's full write-up lands next to it as `annexure-N.md`). Open `report.md` — that's your first cited report. For the exact file layout and how to replay a past run, see the [outputs & replay guide](./guides/outputs-and-replay.md).

That's it — install, ask, approve, read. You now have a cited report produced entirely on your own machine.

## Next steps

- **[How a run works](./guides/how-a-run-works.md)** — the full mental model: planning, clarify rounds, per-source toggles, flat vs deep, effort, and the run controls (STOP / WRAP UP / cancel an agent).
- **[Research the web](./guides/research-the-web.md)** — the keyless default web search and adding a Tavily key.
- **[Research your files](./guides/research-your-files.md)** — point the agents at a local corpus of your own documents.
- **[Models & GPU](./guides/models-and-gpu.md)** — bring your own `.gguf`, hot-swap models, and select a GPU backend.
- **[Scripting](./guides/scripting.md)** — run headless in CI or a pipeline with `--query` and `--jsonl`.
- **[Outputs & replay](./guides/outputs-and-replay.md)** — where files land and how to replay a past run.
- **[CLI reference](./cli-reference.md)** — every flag, env var, and slash command in one place.
- **[Configuration](./configuration.md)** — the `harness.json` file and its keys.
