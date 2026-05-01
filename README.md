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

### Settings in the composer

Press `Esc` to open the menu mode:

- `W` → set Tavily key (or clear with empty)
- `C` → set corpus path (or clear with empty)
- `O` → set output dir (or clear to fall back to cwd)
- `T` → toggle Deep / Fast reasoning
- `Esc` → back to the query input

Everything persists to `harness.json` the moment you save.

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

- Built on [`@lloyal-labs/*`](https://github.com/lloyal-ai/lloyal-sdk) for the agent runtime, session/branch primitives, and RIG tools.
- Local inference via `@lloyal-labs/lloyal.node` (llama.cpp Node binding).
- UI via Ink (React for terminals).

## License

Apache 2.0.
