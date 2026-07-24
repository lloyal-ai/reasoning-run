/**
 * DRB citation weave — deterministic post-processing that turns a research
 * agent's `report()` result into already-inline-cited text.
 *
 * Background: DeepResearch-Bench's FACT metric scores 0 when a report carries
 * no inline `[title](url)` citations at its claims (an end-of-document Sources
 * list does not count). At 4B scale the synthesizer mirrors the citation FORMAT
 * of its input rather than obeying an abstract "cite inline" mandate — so the
 * durable fix is to seed the format in the findings themselves. The `report()`
 * terminal tool now carries a grammar-forced `sources: [{title, url}]` field
 * (see structured-report.ts); this helper weaves that structured array into the
 * findings string at result capture, so synthesis input + annexures are already
 * inline-cited.
 *
 * Semantics (kept byte-identical to the validated dist patch, so the unit test
 * ports 1:1): for each {title, url} — replace every BARE occurrence of the exact
 * url with `[title](url)`, SKIPPING urls already inside a markdown link (preceded
 * by `](`) or inside parens (preceded by `(`); then append a trailing `Sources:`
 * list. Sources are de-duplicated by url and processed LONGEST-url-first so a
 * shorter prefix url (`https://x.com`) can't corrupt a longer occurrence
 * (`https://x.com/page`). Pure + defensive: a non-string result or an
 * empty/absent/non-array `sources` returns `result` unchanged. No new fields and
 * no type changes on the capture seam — the result stays a plain string.
 */

/** Structured source as emitted in the `report()` tool's `sources` field. */
export interface WeaveSource {
  title: string;
  url: string;
}

export function weaveSourcesIntoResult(result: string, sources: unknown): string;
export function weaveSourcesIntoResult(result: unknown, sources: unknown): unknown;
export function weaveSourcesIntoResult(result: unknown, sources: unknown): unknown {
  if (typeof result !== "string" || !Array.isArray(sources) || sources.length === 0) {
    return result;
  }

  const seen = new Set<string>();
  const clean: WeaveSource[] = [];
  for (const s of sources as unknown[]) {
    if (!s || typeof s !== "object") continue;
    const rec = s as { url?: unknown; title?: unknown };
    if (typeof rec.url !== "string" || typeof rec.title !== "string") continue;
    const url = rec.url.trim();
    const title = rec.title.trim();
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    clean.push({ url, title });
  }

  // Longest url first — a shorter prefix url must not corrupt a longer occurrence.
  clean.sort((a, b) => b.url.length - a.url.length);

  let out = result;
  const lines: string[] = [];
  for (const { url, title } of clean) {
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Capture a preceding `](` (already a link target) or `(` (parens) so those
    // occurrences are left untouched; a bare occurrence has no prefix → wrap it.
    const re = new RegExp("(\\]\\(|\\()?" + esc, "g");
    out = out.replace(re, (m, pre) => (pre ? m : `[${title}](${url})`));
    lines.push(`- [${title}](${url})`);
  }

  if (lines.length > 0) {
    out = out + "\n\nSources:\n" + lines.join("\n");
  }
  return out;
}
