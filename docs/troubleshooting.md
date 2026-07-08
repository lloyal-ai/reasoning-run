# Troubleshooting

**What this covers:** the handful of failures new users actually hit — an old Node version, a failed first-run model download, a run that quietly uses the CPU instead of your GPU, and out-of-memory / context-size mistakes — each as *problem → cause → fix*.

For the full flag, environment-variable, and slash-command surface referenced below, see the [CLI reference](./cli-reference.md). For every `harness.json` key, see [Configuration](./configuration.md).

---

## `npx reasoning.run` crashes on start (old Node)

**Problem.** Instead of the app, you get an `npm warn EBADENGINE` line and/or a raw stack trace on stderr (`Error: …`), and the process exits without ever showing the interface.

**Cause.** reasoning.run requires **Node ≥ 24** (declared in `package.json` `engines`). npm's engine check is only a *warning* by default — it does not stop the launch — so on Node 22 or 23 the app starts, then crashes when it hits a Node 24 feature. There is no friendly "please upgrade" message; the launcher just prints the underlying error and exits.

**Fix.** Upgrade to Node 24 or newer, then rerun:

```bash
node --version        # must print v24.x or higher
npx reasoning.run
```

If you manage versions with `nvm`, `nvm install 24 && nvm use 24`. See [Prerequisites](./getting-started.md#prerequisites) for the full requirement list.

---

## First-run model download fails

**Problem.** On the very first run, reasoning.run downloads its default models (~3 GB — a `.gguf` is the on-disk weight file format the engine loads). If the network drops or the mirror is unreachable, boot stops on an error screen naming the model that failed to load.

**Cause.** The weights aren't present yet and couldn't be fetched. Nothing is cached, so the next launch simply retries the same download.

**Fix — interactive (TUI).** The boot error screen waits for a recovery command. Point it at a model file you already have on disk:

```
/model /path/to/your-model.gguf
```

You can likewise recover the reranker with `/reranker <path>` or change backend with `/gpu <backend>`. The path is saved to `harness.json`, and boot retries immediately. (A "reranker" re-ranks retrieved snippets by relevance before the agents read them.)

Alternatively, fix the network and relaunch — the download resumes from scratch, and once complete the weights are cached in `~/.cache/lloyal/models/` so it never re-downloads.

**Fix — headless (`--jsonl` / no TTY).** There is no interactive recovery loop in non-interactive mode: a boot failure prints `Boot failed (<llm|reranker|backend-pack>): <message>` to stderr and exits with code `2`. Supply a local model up front so nothing needs downloading:

```bash
npx reasoning.run --query "…" --jsonl --model /path/to/your-model.gguf
```

See [Models and GPUs](./guides/models-and-gpu.md) for where to get a `.gguf` and how the catalog default works.

---

## It runs on the CPU instead of my GPU

**Problem.** A run is far slower than expected and your GPU sits idle — reasoning.run fell back to the CPU without saying so.

**Cause.** The engine's model loader **silently falls back to CPU** when the GPU backend it was asked for can't load (wrong backend for your card, missing driver, an architecture the default build doesn't cover). Unless you tell it otherwise, a failed GPU load degrades to CPU rather than erroring.

**How to tell.** Watch your GPU while a run is active — e.g. `nvidia-smi` on NVIDIA, or your OS GPU monitor. If utilization and VRAM stay flat during the run, it's on the CPU.

**Fix.** Two ways to turn the silent fallback into a *hard* failure so the problem surfaces at boot instead of hiding:

1. **Request a backend explicitly.** When you select a GPU backend with the **`--gpu` flag** — `--gpu cuda` (or `--gpu vulkan` / `--gpu default`) — or with **`model.gpu` in `harness.json`**, reasoning.run automatically refuses to fall back: an unavailable backend fails loud at boot with a `/gpu` recovery prompt. *(A bare `LLOYAL_GPU` environment variable only **selects** the backend — it does **not** enable this hard-fail, so it still permits the silent CPU fallback. To force a hard failure with `LLOYAL_GPU`, also set `LLOYAL_NO_FALLBACK=1`, below.)*
2. **Set `LLOYAL_NO_FALLBACK`.** Export `LLOYAL_NO_FALLBACK=1` to force a hard failure on *any* GPU-load problem. A value you set yourself is always respected.

```bash
LLOYAL_NO_FALLBACK=1 npx reasoning.run --gpu cuda
```

Note: **`--gpu metal` is rejected** — Metal is used automatically on Apple Silicon and is not a selectable backend. See [Choosing a GPU](./guides/models-and-gpu.md#choosing-a-gpu) for the full backend story, including the Linux + CUDA **backend-pack** for datacenter-class cards. `LLOYAL_NO_FALLBACK` and `LLOYAL_GPU` are listed in the [environment-variable table](./cli-reference.md#environment-variables).

---

## Out of memory, or "the agent pool is empty"

**Problem.** Either the model fails to load with an out-of-memory error, or a run starts but no research agents ever appear (an empty agent pool) — usually right after you lowered the context size to save memory.

**Cause.** `nCtx` is the model's context window in tokens. reasoning.run's default is **32768**, and the main model context is opened with **64 sequence slots** that the research agents draw from — the whole `nCtx` budget is shared across those slots. Cut `nCtx` too far and each slot is starved: at **`nCtx: 2048`** there isn't enough context to seat the agents, and **the pool comes up empty**. (The reranker's context is separately hard-pinned at 16384 and isn't affected by your setting.)

**Fix.**

- **Keep the `32768` default.** Don't lower `nCtx` as a first reflex — it's the most common self-inflicted failure. In particular, never drop to `2048`.
- **If you genuinely hit VRAM out-of-memory at load,** the model + context don't fit your card. Prefer a **smaller or more-quantized `.gguf`**, or a bigger GPU via the backend-pack — rather than shrinking `nCtx` into the range that empties the pool.
- `nCtx` is set with `--n-ctx <int>`, the `LLAMA_CTX_SIZE` environment variable, or `model.nCtx` in `harness.json`. `--n-ctx` rejects non-integer values. See [`model.nCtx`](./configuration.md#keys) and [Context window](./guides/models-and-gpu.md#context-window-nctx).

---

## Windows-specific failures

> **TODO(confirm):** Windows-specific failure modes (and the supported GPU backend on Windows) are not yet documented. Confirm before publish — do not guess. Linux + CUDA/Vulkan and macOS (Metal automatic on Apple Silicon; x64 is CPU-only) are the surfaces verified against v0.5.1 source.
