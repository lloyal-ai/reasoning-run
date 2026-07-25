/**
 * Behavioral smoke test for the DRB citation weave.
 *
 *   npx tsx src/__weave-smoke.ts
 *
 * Unlike the harness-adjacent smokes (which read source as text because
 * `harness.ts`'s `.eta` imports need the esbuild text loader), `weave-sources.ts`
 * is a pure, dependency-free module — so this imports the REAL
 * `weaveSourcesIntoResult` and exercises its behavior directly. Cases 1-9 are
 * ported 1:1 from the validated dist patch's `test_weave.js` (bare-url weave +
 * Sources append, already-linked skip, prefix-collision ordering, empty/undefined/
 * non-string defensiveness, parens guard, dedup, malformed-entry skip); cases
 * 10-12 lock in the right-boundary fix (a declared source url that is a prefix of
 * a longer body url must not corrupt it).
 */

import assert from "node:assert";
import { weaveSourcesIntoResult } from "./weave-sources";

let pass = 0;
let fail = 0;

function check(name: string, got: unknown, want: unknown): void {
  try {
    assert.deepStrictEqual(got, want);
    pass++;
    process.stdout.write(`ok  ${name}\n`);
  } catch {
    fail++;
    process.stdout.write(
      `FAIL ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}\n`,
    );
  }
}

// 1. bare url woven + Sources appended
check(
  "bare url",
  weaveSourcesIntoResult("Elderly pop rises per https://stat.go.jp/data here.", [
    { title: "Stats JP", url: "https://stat.go.jp/data" },
  ]),
  "Elderly pop rises per [Stats JP](https://stat.go.jp/data) here.\n\nSources:\n- [Stats JP](https://stat.go.jp/data)",
);

// 2. url already inside a markdown link -> not double-wrapped, still listed
check(
  "already-linked",
  weaveSourcesIntoResult("See [Stats](https://stat.go.jp/data).", [
    { title: "Stats JP", url: "https://stat.go.jp/data" },
  ]),
  "See [Stats](https://stat.go.jp/data).\n\nSources:\n- [Stats JP](https://stat.go.jp/data)",
);

// 3. prefix collision: longer url must win, shorter must not corrupt it
check(
  "prefix collision",
  weaveSourcesIntoResult("A https://x.com/page and B https://x.com end.", [
    { title: "Short", url: "https://x.com" },
    { title: "Long", url: "https://x.com/page" },
  ]),
  "A [Long](https://x.com/page) and B [Short](https://x.com) end.\n\nSources:\n- [Long](https://x.com/page)\n- [Short](https://x.com)",
);

// 4. empty sources array -> unchanged
check("empty sources", weaveSourcesIntoResult("no urls", []), "no urls");

// 5. undefined sources (recovery truncated case) -> unchanged
check("undefined sources", weaveSourcesIntoResult("no urls", undefined), "no urls");

// 6. non-string result -> returned as-is
check("non-string result", weaveSourcesIntoResult(null, [{ title: "t", url: "u" }]), null);

// 7. url in parens (guard) -> not wrapped, but still listed
check(
  "parens guard",
  weaveSourcesIntoResult("ref (https://a.io) x", [{ title: "A", url: "https://a.io" }]),
  "ref (https://a.io) x\n\nSources:\n- [A](https://a.io)",
);

// 8. duplicate sources deduped in list, both bare occurrences woven
check(
  "dup dedup",
  weaveSourcesIntoResult("one https://a.io two https://a.io", [
    { title: "A", url: "https://a.io" },
    { title: "A", url: "https://a.io" },
  ]),
  "one [A](https://a.io) two [A](https://a.io)\n\nSources:\n- [A](https://a.io)",
);

// 9. malformed entry skipped
check(
  "malformed skipped",
  weaveSourcesIntoResult("here https://ok.io", [
    { title: "OK", url: "https://ok.io" },
    { url: "https://nourl.io" },
    null,
  ]),
  "here [OK](https://ok.io)\n\nSources:\n- [OK](https://ok.io)",
);

// 10. right-boundary: a declared source that is a prefix of a LONGER body url must
// not corrupt that longer url.
check(
  "prefix of longer body url",
  weaveSourcesIntoResult(
    "See https://en.wikipedia.org/wiki/Japan and https://en.wikipedia.org/wiki/Japanese_economy here.",
    [{ title: "Japan", url: "https://en.wikipedia.org/wiki/Japan" }],
  ),
  "See [Japan](https://en.wikipedia.org/wiki/Japan) and https://en.wikipedia.org/wiki/Japanese_economy here.\n\nSources:\n- [Japan](https://en.wikipedia.org/wiki/Japan)",
);

// 11. right-boundary: a query string on a longer body url is preserved
check(
  "query string preserved",
  weaveSourcesIntoResult("Data at https://stat.go.jp/data?year=2024 shows growth.", [
    { title: "Stats", url: "https://stat.go.jp/data" },
  ]),
  "Data at https://stat.go.jp/data?year=2024 shows growth.\n\nSources:\n- [Stats](https://stat.go.jp/data)",
);

// 12. trailing sentence punctuation still wraps (period left outside the link)
check(
  "trailing period",
  weaveSourcesIntoResult("Confirmed at https://a.io.", [{ title: "A", url: "https://a.io" }]),
  "Confirmed at [A](https://a.io).\n\nSources:\n- [A](https://a.io)",
);

// 13. a title with `[` / `]` is escaped so it can't break the link syntax
check(
  "bracketed title escaped",
  weaveSourcesIntoResult("See https://a.io here.", [{ title: "Foo [Bar] Baz", url: "https://a.io" }]),
  "See [Foo \\[Bar\\] Baz](https://a.io) here.\n\nSources:\n- [Foo \\[Bar\\] Baz](https://a.io)",
);

// 14. right-boundary: a source that is a prefix up to a `.`-extension (`.pdf`) or a
// longer domain must NOT corrupt the longer body url (the `.` there continues it).
check(
  "prefix before dot-extension not corrupted",
  weaveSourcesIntoResult("See https://a.io/doc.pdf now.", [{ title: "Doc", url: "https://a.io/doc" }]),
  "See https://a.io/doc.pdf now.\n\nSources:\n- [Doc](https://a.io/doc)",
);

// 15. but the exact source before a sentence-final period still wraps (period out)
check(
  "exact url before sentence period still wraps",
  weaveSourcesIntoResult("Read https://a.io/doc. Done.", [{ title: "Doc", url: "https://a.io/doc" }]),
  "Read [Doc](https://a.io/doc). Done.\n\nSources:\n- [Doc](https://a.io/doc)",
);

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
