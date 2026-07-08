# CLI reference

The complete surface for reasoning.run v0.5.1 in one place: every flag, environment variable, slash command, and interactive control, plus how they override each other. This is the authoritative lookup — the guides link here rather than repeat these tables.

reasoning.run runs as a single command — `npx reasoning.run` — with no subcommands. There is no `--help` or `--version`; invalid arguments print a targeted error to stderr and exit.

The **first positional argument is the LLM model path or catalog id** — equivalent to `--model`. Passing both a positional and `--model` with **different** values is ambiguous and exits with code 1 ("Conflicting model paths"). Passing the same value in both is fine.

```bash
npx reasoning.run                          # interactive TUI, catalog default model
npx reasoning.run ./my-model.gguf          # positional == --model
npx reasoning.run --query "..." --jsonl    # headless, machine-readable
```

Everything below is optional. Anything you can set here you can also set in `harness.json` — see [configuration.md](./configuration.md#keys).

## Flags

All flags are long-form only — there are no short aliases. A `.gguf` is a single-file GGUF model weight (the format llama.cpp loads).

| Flag | Value(s) | Default | Purpose |
|---|---|---|---|
| `--query <text>` | any string | *(none)* | Run one query non-interactively, then exit. **Required** when not attached to a TTY or when `--jsonl` is set. See [scripting.md](./guides/scripting.md). |
| `--model <path\|id>` | `.gguf` path or catalog id | catalog default | The LLM to load. Same as the first positional and `/model`. See [models-and-gpu.md](./guides/models-and-gpu.md). |
| `--reranker <path\|id>` | `.gguf` path or catalog id | catalog default | The reranker model (a small model that re-scores search hits by relevance). Same as `/reranker`. |
| `--corpus <path>` | directory or glob path | *(none)* | Research a local file corpus (a folder of your own files). Same as `/scan`. See [research-your-files.md](./guides/research-your-files.md). |
| `--config <path>` | path to a `harness.json` | `./harness.json` | Load config from a non-default path. See [configuration.md](./configuration.md). |
| `--gpu <cuda\|vulkan\|default>` | `cuda`, `vulkan`, or `default` | platform built-in backend | Select the GPU backend. **Rejects `metal`** — Metal is automatic on Apple Silicon; omit `--gpu` there. `default` clears a persisted choice. See [models-and-gpu.md](./guides/models-and-gpu.md). |
| `--findings-budget <int>` | integer | built-in | Character budget for the findings each agent gathers before synthesis. |
| `--reasoning-mode <flat\|deep>` | `flat` or `deep` | `flat` | Parallel (`flat`) vs chained (`deep`) reasoning. Same as `/flat` / `/deep`. See [how-a-run-works.md](./guides/how-a-run-works.md). |
| `--n-ctx <int>` | positive integer | `32768` | Model context window in tokens. The reranker's context is hard-pinned to `16384`. See the OOM/low-nCtx note in [troubleshooting.md](./troubleshooting.md). |
| `--output-dir <path>` | directory path | launch directory | Where the run bundle is written. See [outputs-and-replay.md](./guides/outputs-and-replay.md). |
| `--backend-pack <download\|skip>` | `download` or `skip` | *(interactive offer)* | Downloads a signed full-architecture CUDA backend (**Linux + CUDA only**) for GPUs beyond the default build. See [models-and-gpu.md](./guides/models-and-gpu.md). |
| `--jsonl` | *(boolean flag)* | `false` | Emit machine-readable JSONL to stdout and skip the TUI. Implies non-TTY mode (requires `--query`). |
| `--verbose` | *(boolean flag)* | `false` | Extra diagnostic logging. |
| `--replay-trace <path>` | path to a `trace-*.jsonl` | *(none)* | Replay a past run from its trace file. See [outputs-and-replay.md](./guides/outputs-and-replay.md). |

> **Effort has no CLI flag.** There is no `--effort`. Set the effort tier (`low`, `medium`, `high`, `ultra`; default `high`) live in the TUI via the [`/effort`](#slash-commands) slider, or persist it with `defaults.effort` in [harness.json](./configuration.md#keys). `ultra` is the maximum tier and is calibration-unstable.

## Environment variables

| Variable | Effect |
|---|---|
| `TAVILY_API_KEY` | Tavily web-search API key. **Wins over a key stored in `harness.json`** at read time, and is **never persisted to disk** while set. See [research-the-web.md](./guides/research-the-web.md). |
| `LLAMA_CTX_SIZE` | Context-window fallback — an env-level source for `--n-ctx` / `model.nCtx`. |
| `LLOYAL_GPU` | GPU-backend fallback (`cuda`\|`vulkan`\|`default`). A bare env var keeps the loader's warn-and-fall-back-to-CPU behavior. |
| `LLOYAL_NO_FALLBACK` | Set to `1` to make an unavailable GPU backend **error at boot** instead of silently falling back to CPU. See [troubleshooting.md](./troubleshooting.md). |
| `XDG_CACHE_HOME` | Overrides the cache base directory. Models are cached under `$XDG_CACHE_HOME/lloyal/models/` (default `~/.cache/lloyal/models/`). |
| `RR_BRIDGE` | **Internal — not user-facing.** Electron bridge signal used by the desktop host; do not set it yourself. |

## Slash commands

Type these inside the TUI. Six set a value (they take an argument); the rest fire instantly.

| Command | Kind | Effect |
|---|---|---|
| `/scan <path>` | value | Set the local file source (path or glob). Same as `--corpus`. |
| `/web <key>` | value | Set the Tavily web-search key. |
| `/model <path>` | value | Set the local LLM `.gguf`. **Hot-swaps live weights** (restarts the boot loop). |
| `/reranker <path>` | value | Set the local reranker `.gguf`. **Hot-swaps live weights** (restarts the boot loop). |
| `/gpu <cuda\|vulkan\|default>` | value | Set the GPU backend. Same as `--gpu`. |
| `/output <path>` | value | Set the output directory. Same as `--output-dir`. |
| `/effort` | instant | Open the effort slider (`low·medium·high·ultra`). This is the only way to change effort at runtime. |
| `/deep` | instant | Switch to deep (chain) reasoning. |
| `/flat` | instant | Switch to flat (parallel) reasoning. |
| `/help` | instant | Show the command list. |
| `/quit` | instant | Quit. |

## Interactive controls

Keyboard controls inside the TUI, beyond the slash commands above.

**Plan editor** (after the planner proposes a plan):

| Key | Action |
|---|---|
| `↑` / `↓` | Move focus over tasks and the START button |
| `⏎` | On a task: edit it. On START: begin research. |
| `A` | Add an empty task after the focused one |
| `D` | Delete the focused task |
| `⇧↑` / `⇧↓` | Reorder the focused task up / down |
| `Esc` | Cancel the plan |

**Clarify rounds** — the planner may ask follow-up questions; answer them before START.

**Per-source participation** — press `Space` on a source chip (web / corpus / output) to include or exclude that source in the run.

**Starting a run:**
- **START (planned)** — run the plan you reviewed and edited.
- **START (direct ask)** — skip the planner entirely; reasoning.run synthesizes a single-task plan and answers directly. Toggle the PLAN ↔ START target with `Shift+Tab`.
- **deep / flat toggle** — switch reasoning mode from the plan review (also via `/deep` / `/flat`).

**While agents work:**

| Control | Action |
|---|---|
| **STOP** | Abort the in-flight run and return to the composer. |
| **WRAP UP** | Graceful drain — stop spawning, let in-flight agents finish, then synthesize what's gathered. |
| Number keys `1`–`9` | Cancel one live research agent; its siblings keep running. |

## Precedence

When the same setting is provided in more than one place, the higher wins:

```
CLI flag  >  environment variable  >  harness.json  >  built-in default
```

The config file is [`harness.json`](./configuration.md) in your working directory. See [configuration.md#keys](./configuration.md#keys) for every key and [configuration.md#examples](./configuration.md#examples) for worked configs.
