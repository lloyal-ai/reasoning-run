# reasoning.run

A private reasoner for your terminal. Direct conversation or grounded multi-agent research, GPU-native and fully local. No API keys, no inference servers. Open source (MIT).

```
npx reasoning.run
```

Then type a research question.

<p>
  <img src="assets/demo-readme.gif" alt="reasoning.run: clarifying questions → plan approval → 5 research agents in parallel → synthesized report" width="100%">
  <br>
  <em>Qwen3.5 4B + Qwen3 0.6B reranker · 5 parallel agents · shared 32K context · fully offline on M2 MacBook Pro 16 GB</em>
</p>

> Built with **[HDK](https://hdk.lloyal.ai/)** — Lloyal's Harness Development Kit. An in-app intelligence runtime for local-first apps: models, agents, tools, and retrieval in one import — no model server, no API keys.

**Empirically:** 5 research agents running concurrently in a shared 32K-token context window, Qwen3.5-4B as the LLM, on a MacBook Pro M2 (16 GB unified memory). No GPU server, no API keys, no inference fees. Every token is decoded on the device that asked the question.

## What you get

- **Plan, edit, run.** A small planner decomposes your question into research tasks. You see the plan in a TUI editor — navigate with ↑↓, edit a task with ⏎, add/delete/reorder with `A`/`D`/`⇧↑↓`. Press START on a plan you actually agree with. Nothing runs until you say so.
- **5 agents in one context window.** HDK's [Continuous Context](https://docs.lloyal.ai/under-the-hood/continuous-context-spine) lets agents share GPU KV state, not strings — five research agents fit inside a single 32K-token budget on a 16 GB MacBook. Decoded in-process, no API calls, no inference server.
- **Retrieval inside the loop.** Each agent searches, fetches, and reranks chunks *during* generation via HDK's [RIG](https://docs.lloyal.ai/build-an-app/sources-and-retrieval) primitives — keyless web search by default (Tavily optional), local markdown for corpus. Adaptive tool use, multi-hop reasoning.
- **Warm follow-ups.** Subsequent queries in the same session reuse the trunk's KV. The planner runs instantly; agents fork from a context that already remembers the prior turn.
- **Hot model swap.** `/model <path>` rebuilds the harness against a new `.gguf` mid-session. Test against different model sizes and quants in seconds, same process.
- **Bundled output per query.** `report.md` (synth answer) + `annexure-N.md` (each research agent's full report) on disk. Grep, diff, share.

First run downloads a Qwen3.5-4B LLM and Qwen3 reranker (~3 GB total, cached in `~/.cache/lloyal/models/`). After that it's all local.

## Configuration

State lives in `./harness.json` (auto-created, auto-gitignored on first save):

```jsonc
{
  "sources": {
    "outputDir": "./reasoning-runs"    // optional — defaults to cwd
  },
  "apps": {                            // per-app config, keyed by app name
    "web": { "tavilyKey": "tvly-..." },    // optional — web search is keyless by default
    "corpus": { "corpusPath": "/path/to/docs" }  // optional — local markdown corpus
  },
  "defaults": {
    "reasoningMode": "flat",           // or "deep"
    "effort": "high"                   // or "medium" | "low"
  },
  "model": {
    "path": "/path/to/llm.gguf",       // optional — local LLM (else catalog default)
    "reranker": "/path/to/rerank.gguf",// optional — local reranker (else catalog default)
    "nCtx": 32768,                     // LLM context window
    "gpu": "cuda"                      // optional — GPU backend (cuda|vulkan|default); omit on macOS (Metal is automatic)
  }
}
```

### Slash commands

Type `/` in the composer to open the command palette. Tab autocompletes; Enter runs.

| Command | Effect |
|---|---|
| `/web <key>` | Set the optional Tavily key (web search works keyless without it). Empty clears. |
| `/scan <path>` | Set local file/glob source. Empty value clears. |
| `/output <dir>` | Set the run-artifact output directory. Empty value resets to cwd. |
| `/model <path>` | Use a local LLM `.gguf` instead of the catalog default. |
| `/reranker <path>` | Use a local reranker `.gguf` instead of the catalog default. |
| `/gpu <cuda\|vulkan\|default>` | Set the GPU backend; restarts the model on the new binding. |
| `/deep` | Switch to deep (chain) reasoning mode. |
| `/flat` | Switch to flat (parallel) reasoning mode. |
| `/help` | Show the command list inline. |
| `/quit` | Exit. |

Settings persist to `harness.json` the moment you submit. `/model` and `/reranker` **hot-swap the live model mid-session**: type `/model ~/qwen3-8b.gguf` and the harness disposes the current `ctx`, downloads (if needed), loads the new weights, and returns you to the composer — same process, same Ink session, no restart. (Same flow recovers from boot-time download failures: type `/model <path>` at the BootStatus prompt to continue with a local file.)

## Run artifacts

Every query writes a self-contained bundle under `<output-dir>/<ISO-timestamp>/`:

```
<output-dir>/
  trace-2026-05-01T12-34-56.jsonl       ← session trace (one per process invocation)
  2026-05-01T12-34-56/                  ← query 1
    report.md                           ← synth answer + metadata + annexure index
    annexure-1.md                       ← research agent 1's report
    annexure-2.md
    annexure-3.md
  2026-05-01T13-02-11/                  ← follow-up query 2
    report.md
    annexure-1.md
```

`<output-dir>` defaults to the directory you launched from. Override with `--output-dir <path>` or the composer's `O` hotkey. The session trace captures every query (including warm follow-ups) in one file.

### Environment overrides

- `TAVILY_API_KEY` — wins over the stored key; never persists to disk while set.
- `LLAMA_CTX_SIZE` — context window fallback.
- `LLOYAL_GPU` — GPU backend fallback (`cuda`|`vulkan`|`default`). A bare env var keeps the loader's warn-and-fall-back-to-CPU behavior; set `LLOYAL_NO_FALLBACK=1` to make an unavailable backend error instead. When the backend comes from `--gpu` or `harness.json`, fail-loud is the default.

## CLI flags

All optional. Anything you can set in `harness.json` you can also set on the command line; CLI > env > file > defaults. The first positional argument is the model `.gguf` path (equivalent to `--model`).

| Flag | Effect |
|---|---|
| `--query <q>` | Run one query non-interactively, then exit. Implied non-TTY mode. |
| `--model <path>` | Local LLM `.gguf` (same as the first positional / `/model`). |
| `--gpu <cuda\|vulkan\|default>` | GPU backend (alias `--backend`; same as `/gpu`; env `LLOYAL_GPU`). `default` = the platform binary's built-in backend — useful to clear a persisted choice. Explicitly requested backends fail loud at boot if the variant can't load. On macOS, Metal is automatic — no flag needed. |
| `--reasoning-mode <flat\|deep>` | Override the default reasoning mode. |
| `--n-ctx <int>` | LLM context window in tokens. |
| `--corpus <path>` | Local file/glob source (same as `/scan`). |
| `--output-dir <dir>` | Where run artifacts are written (same as `/output`). |
| `--reranker <path>` | Local reranker `.gguf` (same as `/reranker`). |
| `--findings-budget <int>` | Cap (in chars) on per-agent findings forwarded to synth. Default unbounded. |
| `--config <path>` | Use a non-default `harness.json`. |
| `--jsonl` | Stream events as JSONL to stdout (good for piping). |
| `--verbose` | Verbose logs. |

## Keyboard shortcuts

Standard readline chords (work in every terminal):

| Chord | Effect |
|---|---|
| `Ctrl+A` | Jump to line start |
| `Ctrl+E` | Jump to line end |
| `Ctrl+U` | Clear to line start |
| `Ctrl+K` | Clear to line end |
| `Ctrl+W` | Delete word back |
| `Opt+Backspace` | Delete word back (macOS; requires "Use Option as Meta key" in Terminal.app) |
| `Ctrl+C` | Quit |

For Cmd+Backspace / Cmd+arrow to work, turn on "Natural Text Editing" in iTerm2, or use Ghostty.

## How it's built

reasoning.run is a working harness on [Lloyal's **Harness Development Kit**](https://hdk.lloyal.ai/) — the same primitives ship agentic AI directly into desktop and mobile apps, no cloud round-trip required. Specifically:

- **`useAgent`** — single agents with tools and a terminal report tool. Powers the planner, the bridge, and synth.
- **`agentPool` + `parallel`/`chain`** — multi-agent orchestration. Drives the research phase: parallel fan-out for `Flat` mode, chained tasks for `Deep` mode.
- **AgentApps** — capabilities arrive as AgentApps, registered with `createAppRegistry`. reasoning.run enables two: a **web** AgentApp (always on, keyless search by default — Tavily optional) and a **corpus** AgentApp (your local markdown). Each bundles a Source, its Tools, and a prompted skill; the catalog is decoded once into the shared spine, and every research agent reads its role from a short suffix. See [What is an AgentApp](https://docs.lloyal.ai/build-an-app/what-is-an-app).
- **Continuous Context** — agents share GPU KV state instead of re-tokenizing strings, so 5 concurrent agents fit inside one 32K-token context budget on consumer hardware. Also why subsequent queries in the same session are warm and instant — the prior turn's tokens are still in the trunk's KV. ([physics](https://docs.lloyal.ai/under-the-hood/continuous-context-spine))
- **Retrieval-Interleaved Generation (RIG)** — the web and corpus AgentApps return reranker-scored chunks inline *during* generation, so agents search, fetch, and reason in one loop. See [Sources & retrieval](https://docs.lloyal.ai/build-an-app/sources-and-retrieval).
- **Bring your own data — build an AgentApp.** Wrap a vector DB, REST API, JIRA, or any domain surface as an AgentApp and `registry.enable` it; the harness code doesn't change. See [Build an AgentApp](https://docs.lloyal.ai/build-an-app/what-is-an-app).
- **`@lloyal-labs/lloyal.node`** — llama.cpp Node binding for in-process inference.

reasoning.run is open source (MIT) — the whole harness, boot to TUI to research loop, is here to read and fork. If you want to build something similar — a local research tool, a domain-specific agent, an in-app assistant — read the [HDK docs](https://docs.lloyal.ai/) and start with `useAgent`.

UI is [Ink](https://github.com/vadimdemedes/ink) (React for terminals).

## License

MIT © 2026 Lloyal AI. See `LICENSE`. reasoning.run is open source — fork it, study it, ship your own. Its dependencies keep their own licenses: the HDK runtime (`@lloyal-labs/*`) is Fair Source (FSL-1.1-Apache-2.0), the `harness.dev` CLI is Apache-2.0.
