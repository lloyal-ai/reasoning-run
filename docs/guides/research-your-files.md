# Research your own files (corpus)

**What this covers:** how to point reasoning.run at a folder of your own documents — a
**corpus** — so the research agents read your files locally instead of (or alongside) the
web. Includes exactly which file types are supported, and how to run against your files
only, with no network calls.

A **corpus** is a folder (or a single file, or a glob) of your own documents that the
agents can search, grep, and read locally. Nothing is uploaded — the files stay on your
machine.

```bash
npx reasoning.run --corpus ./my-docs
```

## Point reasoning.run at your files

There are three ways to set the corpus. They all resolve to the same place, so pick
whichever fits your workflow:

- **`--corpus <path>`** — one-off at launch, no config file needed. See
  [`--corpus` in the CLI reference](../cli-reference.md#flags).
- **`/scan`** — set (or change) the corpus from inside the TUI while it's running. Type
  `/scan` and enter a path or glob. See
  [slash commands](../cli-reference.md#slash-commands).
- **`apps.corpus.corpusPath`** in `harness.json` — persist it so every run in this
  directory uses the corpus by default. See
  [configuration keys](../configuration.md#keys).

Paths accept `~` for your home directory and are resolved to an absolute path.

## What files it reads

**The corpus only reads Markdown — files ending in `.md` or `.mdx`.** Other formats
(PDF, `.txt`, `.docx`, `.csv`, HTML, source code) are **not** ingested. There is no PDF
extraction and no OCR; if your source material is a PDF or a Word doc, convert it to
Markdown first.

The path you pass can be one of three shapes:

| Input | What happens |
| --- | --- |
| **A single file** — `./notes.md` | Loaded as one document. Must end in `.md`/`.mdx`. |
| **A directory** — `./docs` | Recursively loads every `.md`/`.mdx` file under it (`**/*.{md,mdx}`). |
| **A glob** — `'./docs/*.md'` or `'./docs/**/*.md'` | You control the scope. The pattern's tail must end in `.md`, `.mdx`, or `.{md,mdx}`. |

Notes on directory and glob scanning:

- **A directory is recursive.** To load only the top level of a folder, pass an explicit
  glob instead, e.g. `--corpus './docs/*.md'`.
- **`.gitignore` is honored.** If a `.gitignore` exists at the corpus root, files it
  excludes (for example vendored Markdown under `node_modules/`) are skipped — no
  reasoning.run-specific ignore rules are added, it just respects what you already
  declared.
- **Quote globs in your shell.** Wrap glob patterns in single quotes (as above) so your
  shell passes the pattern through literally instead of expanding it first.
- **Unsupported inputs fail fast.** A non-Markdown file, a path that doesn't exist, or a
  glob that matches nothing prints an error and exits — reasoning.run won't silently skip
  them.

### What the agents do with the corpus

Once indexed, each agent gets three tools over your files: semantic **search** (results
re-scored by a **reranker** — a model that ranks passages by how well they answer the
question), exhaustive **grep** (every regex match, with line numbers), and **read_file**
(verbatim content by line range). You don't invoke these directly; the agents use them as
they research. For how retrieval and reranking work under the hood, see the engine docs at
[docs.lloyal.ai](https://docs.lloyal.ai).

## Run against your files only (offline / confidential)

Web search is always available as a keyless fallback, so by default a run can use both the
web and your corpus. When your material is confidential — or you simply want a fully local,
no-egress run — exclude the web source so agents read **only** your files:

1. Start with your corpus set (`--corpus ./my-docs`, `/scan`, or `apps.corpus.corpusPath`).
2. In the TUI, press **Space** on the **web** source chip to toggle it off for the next
   query. See [interactive controls](../cli-reference.md#interactive-controls).
3. Run your question. With web excluded, agents make no network calls — every answer is
   grounded in your corpus alone.

This is the workflow for sensitive documents: the files never leave your machine, and with
the web chip toggled off there is no outbound request during the run.

> **Note:** the per-query web toggle is an interactive-TUI control. Headless
> [`--query`](../cli-reference.md#flags) runs don't have it, so a scripted run with a
> corpus still has the keyless web fallback active alongside your files.

## Related

- [Research the web](./research-the-web.md) — the keyless default web source and adding a
  Tavily key.
- [Configuration](../configuration.md#keys) — persist `apps.corpus.corpusPath` in
  `harness.json`.
- [CLI reference](../cli-reference.md#flags) — `--corpus`, `/scan`, and the full surface.
