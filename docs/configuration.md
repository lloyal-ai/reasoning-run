# Configuration (`harness.json`)

**What this covers:** every setting you can persist for reasoning.run, where the file lives, and how to write one by hand. If you just want to run a command once, pass a flag instead — see the [CLI reference](./cli-reference.md#flags).

## The file

reasoning.run keeps its persistent settings in **one file: `./harness.json`** — plain JSON, `version: 1`, in your current working directory. There is no YAML, TOML, or dotenv support.

- **Auto-created.** You never have to make it. The first time you change a setting in the TUI (the interactive terminal UI) — for example with `/model`, `/web`, or the `/effort` slider — reasoning.run writes `harness.json` for you.
- **Auto-gitignored.** On that first save, if you are inside a git repository, reasoning.run appends `harness.json` to the nearest `.gitignore` so your settings (and any keys in them) don't get committed by accident.
- **Override the path** with `--config <path>` if you want to keep it somewhere else or run with a different profile.

You can also just create or edit `harness.json` by hand — everything below is a hand-editable field.

## Keys

Every key is optional; anything you omit falls back to its built-in default. A file must set `"version": 1`; a file with any other version is ignored and rebuilt from defaults.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | — | Schema version. Must be `1`. |
| `sources.outputDir` | string (path) | current directory at launch | Where each run's output folder (`report.md` + `annexure-N.md`) and the process trace file are written. See [outputs & replay](./guides/outputs-and-replay.md). |
| `apps.web.tavilyKey` | string | — | Your **Tavily** API key (Tavily is a web-search API). Lets the web source use Tavily instead of the keyless default. See [research the web](./guides/research-the-web.md). |
| `apps.corpus.corpusPath` | string (path) | — | Path to a **corpus** — a folder of your own files the agents read locally. See [research your files](./guides/research-your-files.md). |
| `defaults.reasoningMode` | `"flat"` \| `"deep"` | `"flat"` | Reasoning mode a new run starts in. |
| `defaults.effort` | `"low"` \| `"medium"` \| `"high"` \| `"ultra"` | `"high"` | Session default effort preset. Also settable live via the `/effort` slider. `ultra` is the maximum tier and is calibration-unstable — treat it as experimental. |
| `defaults.maxTurns` | number | `10` | Intended per-agent tool-turn cap. **Not currently honored — see the note below.** |
| `model.path` | string | catalog default | Model to load: a filesystem path to a `.gguf` file (the on-disk format llama.cpp models ship in) **or** a catalog id (e.g. `qwen3.5-4b-q4`). Equivalent to `--model` / the first positional argument. |
| `model.reranker` | string | catalog default | Reranker model (the model that re-scores retrieved passages by relevance): a `.gguf` path or catalog id. |
| `model.nCtx` | number | `32768` | LLM context-window size in tokens. The reranker's context is hard-pinned to `16384` and is **not** affected by this value. |
| `model.gpu` | `"default"` \| `"cuda"` \| `"vulkan"` | `"default"` | GPU backend variant. `default` = the built-in backend (Metal on Apple Silicon, CPU elsewhere). Metal is automatic on Apple Silicon and is **not** a selectable value. See [models & GPU](./guides/models-and-gpu.md). |
| `model.backendPack` | boolean | — | Consent flag for the optional CUDA backend pack. Only `false` is meaningful — it records that you declined the boot-time offer so you won't be asked again. Acceptance is evidenced by the downloaded cache, not by this bit, so it is never set to `true`. |

> **Note:** `defaults.maxTurns` is loaded from the file but **not currently honored** — the run uses a hard-coded limit of 10 turns regardless of what you set. It is documented here for completeness and has been flagged for engineering.

`--gpu` rejects `metal`; Metal is automatic on Apple Silicon and never a value you set. Full per-key value tables live in the [CLI reference](./cli-reference.md#flags).

## Precedence

For any setting, the value that wins is: **CLI flag > environment variable > `harness.json` > built-in default.** So a flag always overrides the file, and the file always overrides the default. Full details, including which settings have an environment-variable rung, are in the [CLI reference](./cli-reference.md#precedence).

Secrets set via an environment variable (for example `TAVILY_API_KEY`) win for that session but are **never** written back to `harness.json`.

## Examples

Each block is a complete, valid `harness.json`. Any key you leave out uses its default, so these show only the fields each scenario needs.

**(a) Web search with your own Tavily key**

```json
{
  "version": 1,
  "apps": {
    "web": {
      "tavilyKey": "tvly-YOUR-KEY-HERE"
    }
  }
}
```

**(b) Corpus-only (no web) — research a local folder**

```json
{
  "version": 1,
  "apps": {
    "corpus": {
      "corpusPath": "~/research/case-files"
    }
  }
}
```

**(c) Pin a bring-your-own model, GPU, and context size**

```json
{
  "version": 1,
  "model": {
    "path": "~/models/Qwen3.5-4B-Q4_K_M.gguf",
    "gpu": "cuda",
    "nCtx": 32768
  }
}
```

---

**See also:** [CLI reference](./cli-reference.md) · [Getting started](./getting-started.md#prerequisites) · [Models & GPU](./guides/models-and-gpu.md) · [Research the web](./guides/research-the-web.md) · [Research your files](./guides/research-your-files.md)
