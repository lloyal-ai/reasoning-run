# Research the web

**What this covers:** how reasoning.run searches the web for you — it works with no setup, and how to plug in a **Tavily** key (Tavily is a web-search API built for AI agents) for higher-quality results.

Web search is always on. Every run has at least one research source because the web source is enabled unconditionally at startup, falling back to a keyless provider when no key is set. You do not have to configure anything to get started:

```bash
npx reasoning.run
```

Ask a question, approve the plan, and the agents search the web to answer it.

## The keyless default

Out of the box, web search runs **without an API key**. This is enough to try the tool and get real cited reports. The keyless provider has lower rate limits and rougher result quality than a keyed one — if you research the web often, add a Tavily key (below).

## Add a Tavily key

A Tavily key unlocks better, higher-volume web search. Get one from your Tavily account, then give it to reasoning.run in **any one** of three ways.

### 1. In the app with `/web`

While the TUI is running, type:

```
/web tvly-your-key-here
```

This stores the key in `harness.json` (see [Configuration](../configuration.md#keys)) the moment you submit. Typing `/web` with no value opens an inline editor pre-filled with the current key; submitting it empty clears the stored key and returns you to keyless mode. See the [slash-command reference](../cli-reference.md#slash-commands).

### 2. The `TAVILY_API_KEY` environment variable

```bash
TAVILY_API_KEY=tvly-your-key-here npx reasoning.run
```

Best for CI, shared machines, and secret managers — the key comes from the environment and is **never written to disk**. See the [environment-variable reference](../cli-reference.md#environment-variables).

### 3. `apps.web.tavilyKey` in `harness.json`

```json
{
  "apps": {
    "web": { "tavilyKey": "tvly-your-key-here" }
  }
}
```

This is the persistent, per-project home for the key — it is exactly what `/web` writes for you. See the [configuration keys](../configuration.md#keys).

## Which key wins, and what gets saved

Two rules govern the three sources above:

- **`TAVILY_API_KEY` always wins.** When the environment variable is set, it takes precedence over any key stored in `harness.json` at read time — the stored key is ignored for that run.
- **The environment key is never persisted.** A key supplied through `TAVILY_API_KEY` is used in memory only and is never written to disk. Only a key you set with `/web` or place in `apps.web.tavilyKey` is saved (in `harness.json`).

So you can keep a project key in `harness.json` for everyday use and override it for a single run by exporting `TAVILY_API_KEY`, with no risk of the override leaking into your config file. For the full ordering across all inputs, see [precedence](../cli-reference.md#precedence).

## When to use web mode

Use web search when your question needs **current or public information** — news, docs, prices, anything on the open internet. It is the default, so most runs use it as-is.

Reach for a different source when the web is the wrong place to look:

- **Your own files.** To research private documents on your machine, point reasoning.run at a folder instead. See [Research your files](./research-your-files.md).
- **Confidential or offline work.** For a corpus-only run that never touches the network, use a local folder as the sole source — again, see [Research your files](./research-your-files.md).

You can also combine sources: enable a local corpus and keep web search on so agents draw from both.
