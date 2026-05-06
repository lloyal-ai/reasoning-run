# reasoning.run

Local deep-research agent composer — runs on your machine, zero-config after the first query.

```
npx reasoning.run
```

Then type a research question.

## What it does

- Downloads a Qwen3.5-4B LLM and Qwen3 reranker on first run (~3 GB, cached in `~/.cache/lloyal/models/`).
- Runs a planner that decomposes your question into research tasks.
- Shows the plan in an Ink-based composer; press Enter to approve or `E` to edit.
- Spawns research agents (parallel for `Fast` mode, chained for `Deep` mode) that query your corpus and/or the web via Tavily.
- Synthesizes findings into a coherent answer, streamed live.

## Configuration

State lives in `./harness.json` (auto-created, auto-gitignored on first save):

```jsonc
{
  "sources": {
    "tavilyKey": "tvly-...",           // optional — web search via Tavily
    "corpusPath": "/path/to/docs",     // optional — local markdown corpus
    "outputDir": "./reasoning-runs"    // optional — defaults to cwd
  },
  "defaults": {
    "reasoningMode": "deep"            // or "flat"
  },
  "model": {
    "nCtx": 32768                      // LLM context window
  }
}
```

### Slash commands

Type `/` in the composer to open the command palette. Tab autocompletes; Enter runs.

| Command | Effect |
|---|---|
| `/web <key>` | Set Tavily API key. Empty value clears. |
| `/scan <path>` | Set local file/glob source. Empty value clears. |
| `/output <dir>` | Set the run-artifact output directory. Empty value resets to cwd. |
| `/model <path>` | Use a local LLM `.gguf` instead of the catalog default. |
| `/reranker <path>` | Use a local reranker `.gguf` instead of the catalog default. |
| `/deep` | Switch to deep (chain) reasoning mode. |
| `/fast` | Switch to fast (parallel) reasoning mode. |
| `/help` | Show the command list inline. |
| `/quit` | Exit. |

Settings persist to `harness.json` the moment you submit. `/model` and `/reranker` also work as a recovery path: if the boot-time download fails (HF outage, no internet, etc.), the BootStatus prompt accepts these commands so you can drop in a pre-downloaded `.gguf` and continue without restarting.

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

## CLI flags

All optional. Anything you can set in `harness.json` you can also set on the command line; CLI > env > file > defaults.

| Flag | Effect |
|---|---|
| `--query <q>` | Run one query non-interactively, then exit. Implied non-TTY mode. |
| `--reasoning-mode <flat\|deep>` | Override the default reasoning mode. |
| `--n-ctx <int>` | LLM context window in tokens. |
| `--corpus <path>` | Local file/glob source (same as `/scan`). |
| `--output-dir <dir>` | Where run artifacts are written (same as `/output`). |
| `--reranker <path>` | Local reranker `.gguf` (same as `/reranker`). |
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

## Source

- Built on [`@lloyal-labs/*`](https://github.com/lloyal-ai/hdk) (Lloyal's Harness Development Kit) for the agent runtime, session/branch primitives, and RIG tools.
- Local inference via `@lloyal-labs/lloyal.node` (llama.cpp Node binding).
- UI via Ink (React for terminals).

## License

Proprietary. © 2026 Lloyal AI. See `LICENSE` for terms.
