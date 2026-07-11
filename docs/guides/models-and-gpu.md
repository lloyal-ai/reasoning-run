# Models and GPUs

**What this covers:** which model reasoning.run runs, how to swap in your own, how to pick a GPU
backend, and how to reach datacenter-class hardware (H100 and friends).

reasoning.run runs entirely on models on *your* machine — there is no hosted API. The defaults work
out of the box; everything on this page is for when you want to change them.

---

## The default models

On first run, reasoning.run downloads two models from its built-in **catalog** (a small list of known,
signed models it can fetch by id) and caches them under `~/.cache/lloyal/models/`:

- **LLM** — `Qwen3.5-4B Q4_K_M` (~2.6 GB). This is the model that plans and writes.
- **Reranker** — `Qwen3-Reranker 0.6B Q8_0` (~0.6 GB). A *reranker* is a small scoring model that
  ranks retrieved passages by relevance so the LLM reads the best evidence first.

Together they're the ~3 GB one-time download noted in
[getting-started → Prerequisites](../getting-started.md#prerequisites). After that, runs are offline.

> The cache location follows `XDG_CACHE_HOME` if set — see the env table in
> [cli-reference → Environment variables](../cli-reference.md#environment-variables).

---

## Bring your own `.gguf`

A **`.gguf`** file is the single-file, quantized model format that reasoning.run loads (the format used
by `llama.cpp`). Point at any local `.gguf` — or another catalog id — instead of the default:

```bash
# first positional argument = model path or catalog id
npx reasoning.run ./models/my-model.gguf

# or the explicit flag (equivalent)
npx reasoning.run --model ./models/my-model.gguf
```

The first positional argument and `--model` are the same lever; passing **both with different values
exits with an error**, so use one. Swap the reranker with its own flag:

```bash
npx reasoning.run --model ./models/my-model.gguf --reranker ./models/my-reranker.gguf
```

To pin these across runs, set `model.path` and `model.reranker` in `harness.json` — see
[configuration → Keys](../configuration.md#keys). Full flag details live in
[cli-reference → Flags](../cli-reference.md#flags).

---

## Swap models mid-session (hot-swap)

You don't have to restart the process to change models. Inside the TUI:

- `/model <path>` — switch the LLM
- `/reranker <path>` — switch the reranker

Both **hot-swap the live weights**: reasoning.run saves the choice and **restarts the boot loop** — the
session tears down the current model/context and re-enters the load phase (same screen, no terminal
flash), then comes back ready with the new weights. See
[cli-reference → Slash commands](../cli-reference.md#slash-commands).

---

## Choosing a GPU

Select a GPU backend with `--gpu`:

```bash
npx reasoning.run --gpu cuda      # NVIDIA (Linux / Windows)
npx reasoning.run --gpu vulkan    # cross-vendor (Linux / Windows)
npx reasoning.run --gpu default   # the platform binary's built-in backend
```

`--gpu` accepts **`cuda`**, **`vulkan`**, or **`default`**. You can set the same thing with the
`LLOYAL_GPU` environment variable or the `model.gpu` config key; a CLI flag wins over the env var, which
wins over `harness.json` (see [cli-reference → Precedence](../cli-reference.md#precedence)). The
`/gpu` slash command sets it from inside the TUI.

### Metal is automatic on Apple Silicon

On an Apple-Silicon Mac, Metal is **built into the binary and used automatically** — you don't select
it. **`metal` is not a `--gpu` value**; `npx reasoning.run --gpu metal` is rejected and exits with an
error. Just omit `--gpu` on a Mac.

---

## Running on datacenter / frontier-class GPUs (backend-pack)

The default CUDA binary supports common consumer cards. Newer datacenter / frontier-class GPUs — an
**H100**, for example — may not be loadable by that default build. The **backend-pack** is the path to
those GPUs.

On **Linux with `--gpu cuda` only**, reasoning.run can download a **signed, full-architecture CUDA
backend** that adds support for GPUs beyond the default build. How it's triggered:

- **Auto-offered.** When the default backend can't load your card, an interactive boot shows a
  *Download / Not now* dialog. Accept to install the pack; the run continues on it. Decline and the
  choice is remembered so you aren't asked again.
- **Force it (headless / CI).** Pass `--backend-pack download` to auto-accept and install without a
  prompt.
- **Suppress it.** Pass `--backend-pack skip` to never probe or offer the pack.

```bash
# Linux + NVIDIA datacenter GPU: install the full-arch CUDA backend, no prompt
npx reasoning.run --gpu cuda --backend-pack download --query "..."
```

Outside Linux+CUDA the pack is never offered. See
[cli-reference → Flags](../cli-reference.md#flags) for the flag, and `model.backendPack` in
[configuration → Keys](../configuration.md#keys) for the persisted setting.

---

## Context window (nCtx)

The model's context window defaults to **32768 tokens**. Change it with `--n-ctx <int>` for one run, or
`model.nCtx` in `harness.json` to persist it (see [configuration → Keys](../configuration.md#keys)).

The **reranker's context is hard-pinned to 16384 tokens** and is not configurable — `model.nCtx` and
`--n-ctx` only affect the main LLM.

> **Don't shrink nCtx to fix memory pressure.** Setting nCtx very low is a known footgun — it can
> starve the agent pool and produce empty runs rather than saving memory. Keep the `32768` default
> unless you're deliberately troubleshooting. See
> [Troubleshooting](../troubleshooting.md) for the out-of-memory / low-nCtx failure mode.

---

Curious how the reranker and context window feed the reasoning engine itself? That's engine internals —
see [docs.lloyal.ai](https://docs.lloyal.ai). This page stays at the "how do I run it" layer.
