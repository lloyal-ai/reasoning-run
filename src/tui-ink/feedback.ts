/**
 * Pure helpers for the /feedback command. No I/O, no side effects — every
 * function is deterministic given its inputs, so the smoke test can pin them.
 *
 * The body is composed to fit GitHub's prefilled-issue URL limit, enforced
 * on the PERCENT-ENCODED length. Errors are best-effort scrubbed (an error
 * message is an arbitrary string — we cannot guarantee no corpus content,
 * only minimise it; the user reviews the issue before submitting).
 */
import type { Config } from './config';
import type { EnvMeta, ErrorRecord } from './state';

const ISSUE_BASE = 'https://github.com/lloyal-ai/reasoning-run/issues/new';
const ISSUE_LABEL = 'feedback';
/** Encoded-URL ceiling; GitHub rejects ~>8KB. Headroom for base + title. */
const MAX_ENCODED_URL = 7000;
const MAX_TITLE = 60;
const MAX_ERROR_LEN = 300;

export interface ScrubCtx {
  query?: string;
  homeDir?: string;
  /** Absolute paths to redact to basenames (model/reranker/corpus/output). */
  paths?: string[];
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drop a trailing lone high surrogate left by slicing on UTF-16 code units —
 *  a lone surrogate makes encodeURIComponent throw. */
function stripLoneSurrogate(s: string): string {
  if (!s) return s;
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** Redact common secret shapes so a key echoed in an error never reaches a
 *  public issue. Best-effort; over-redaction is the safe direction for a
 *  public destination. Covers known-prefix keys, JWTs, KEY=/KEY: fragments,
 *  bearer headers, and high-entropy opaque tokens (UUID / long hex / long
 *  mixed base64). */
function redactSecrets(s: string): string {
  return s
    // JWTs (header.payload.signature); tolerate whitespace a logger wraps in.
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\s*\.\s*[A-Za-z0-9_-]{4,}\s*\.\s*[A-Za-z0-9_-]{4,}/g, '[redacted-token]')
    // Provider / API key shapes with known prefixes.
    .replace(/\b(tvly|sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AIza|AKIA|ASIA|hf)[-_][A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    // KEY=VALUE / KEY:VALUE where the key name looks secret (case-insensitive).
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    // Bearer / Authorization headers.
    .replace(/\b(Bearer|Authorization)\b\s*:?\s*\S+/gi, '$1 [redacted]')
    // UUIDs (session/correlation tokens).
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted-id]')
    // Long hex runs (md5/sha/40-hex tokens).
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted-hex]')
    // Long mixed base64/base64url runs (require both a digit and a letter so
    // ordinary SNAKE_CASE identifiers and words are not redacted).
    .replace(/\b(?=[A-Za-z0-9_+/-]*[0-9])(?=[A-Za-z0-9_+/-]*[A-Za-z])[A-Za-z0-9_+/-]{40,}={0,2}/g, '[redacted-token]');
}

export function scrubError(message: string, ctx: ScrubCtx): string {
  let s = message;
  // 1. Redact known secret shapes first.
  s = redactSecrets(s);
  // 2. Redact the session/error query — case-insensitive and whitespace-
  //    tolerant (backends echo queries re-cased / re-wrapped), but only when
  //    it's specific enough that matching won't over-redact ordinary words.
  const q = ctx.query?.trim();
  if (q && q.length >= 4) {
    const pat = escapeRegExp(q).replace(/\s+/g, '\\s+');
    s = s.replace(new RegExp(pat, 'gi'), '[query]');
  }
  // 3. Collapse ANY scheme://[userinfo@]host[:port][/path?query] to
  //    scheme://host — drops inline credentials (userinfo), path, and query
  //    for every scheme (http, ftp, ws, postgres, mongodb, redis, …). This is
  //    the credential-leak fix: userinfo lives before the first slash.
  s = s.replace(
    /\b([a-z][a-z0-9+.-]*):\/\/(?:[^/@\s]*@)?(\[[^\]\s]+\]|[^/:?#\s]+)(?::\d+)?(?:[/?#]\S*)?/gi,
    (_m, scheme, host) => `${scheme}://${host}`,
  );
  // 4. Configured paths → basename.
  for (const p of ctx.paths ?? []) {
    if (p && s.includes(p)) s = s.split(p).join(basename(p));
  }
  // 5. Home dir → ~ (path-boundary only, so a /home/jo home dir doesn't
  //    mangle an unrelated sibling like /home/joanna).
  if (ctx.homeDir && ctx.homeDir.trim()) {
    s = s.replace(new RegExp(escapeRegExp(ctx.homeDir) + '(?=/|\\\\|\\s|$)', 'g'), '~');
  }
  // 6. Remaining filesystem paths (POSIX + Windows + UNC) → basename. The
  //    lookbehind keeps it from biting into a `scheme://` remnant.
  s = s.replace(/(?<![:/\\])(?:[A-Za-z]:\\|\\\\|\/)[^\s:?"<>|]+/g, (m) => basename(m));
  // 7. Length bound (code-point safe — never leave a lone surrogate, which
  //    would later crash encodeURIComponent).
  if (s.length > MAX_ERROR_LEN) s = stripLoneSurrogate(s.slice(0, MAX_ERROR_LEN)) + '…';
  return s.trim();
}

export function feedbackTitle(message: string): string {
  const firstLine = (message.split('\n')[0] ?? '').trim() || 'feedback';
  const clipped = firstLine.length > MAX_TITLE
    ? stripLoneSurrogate(firstLine.slice(0, MAX_TITLE))
    : firstLine;
  return `Feedback: ${clipped}`;
}

export function formatEnvLines(
  env: EnvMeta | null,
  config: Config | null,
  mode: 'flat' | 'deep' | null,
): string[] {
  const lines: string[] = [];
  if (env) {
    lines.push(`- reasoning.run: ${env.version}`);
    lines.push(`- OS: ${env.platform} ${env.arch}`);
    lines.push(`- CPU: ${env.cpuModel}`);
    lines.push(`- Node: ${env.nodeVersion}`);
    lines.push(`- GPU: ${env.gpu}`);
  }
  const modelPath = config?.model.path;
  const rerankPath = config?.model.reranker;
  if (modelPath) lines.push(`- Model: ${basename(modelPath)}`);
  if (rerankPath) lines.push(`- Reranker: ${basename(rerankPath)}`);
  if (mode) lines.push(`- Mode: ${mode}`);
  return lines;
}

export interface BuildBodyInput {
  message: string;
  env: EnvMeta | null;
  config: Config | null;
  mode: 'flat' | 'deep' | null;
  errors: ErrorRecord[];
  includeErrors: boolean;
  scrubCtx: ScrubCtx;
}

function encodedLen(title: string, body: string): number {
  return (
    ISSUE_BASE.length +
    '?labels='.length + ISSUE_LABEL.length +
    '&title='.length + encodeURIComponent(title).length +
    '&body='.length + encodeURIComponent(body).length
  );
}

export function buildFeedbackBody(input: BuildBodyInput): { body: string; truncated: boolean } {
  const { message, env, config, mode, errors, includeErrors, scrubCtx } = input;
  const envLines = formatEnvLines(env, config, mode);
  const header = (msg: string) => `${msg}\n\n## Environment\n${envLines.join('\n')}\n`;
  const title = feedbackTitle(message);

  let truncated = false;
  const MARKER = '\n…(truncated)';

  // 1. Message + environment always fit; truncate the message if even that
  //    overflows. Account for the MARKER's own (multibyte) encoded length once
  //    truncation starts, and slice code-point-safe so a split surrogate pair
  //    never crashes encodeURIComponent.
  let msg = message;
  while (
    msg.length > 0 &&
    encodedLen(title, header(truncated ? msg + MARKER : msg)) > MAX_ENCODED_URL
  ) {
    truncated = true;
    msg = stripLoneSurrogate(msg.slice(0, Math.max(0, msg.length - 64)));
  }
  if (truncated) msg = msg.replace(/\s*$/, '') + MARKER;
  let body = header(msg);

  // 2. Add scrubbed errors greedily while they fit. Each error is scrubbed
  //    against its OWN captured query (falling back to the current one), so an
  //    older query embedded in a persisted error doesn't leak.
  if (includeErrors && errors.length) {
    const scrubbed = errors
      .map((e) => scrubError(e.message, { ...scrubCtx, query: e.query ?? scrubCtx.query }))
      .filter(Boolean);
    const kept: string[] = [];
    for (let i = 0; i < scrubbed.length; i++) {
      const candidate = kept.concat(scrubbed[i]);
      const section = `\n## Errors (${candidate.length})\n` +
        candidate.map((m, j) => `${j + 1}. ${m}`).join('\n') + '\n';
      if (encodedLen(title, header(msg) + section) > MAX_ENCODED_URL) {
        truncated = true;
        break;
      }
      kept.push(scrubbed[i]);
    }
    if (kept.length) {
      const render = (arr: string[], omitted: number): string =>
        header(msg) +
        `\n## Errors (${arr.length})\n` +
        arr.map((m, j) => `${j + 1}. ${m}`).join('\n') + '\n' +
        (omitted > 0 ? `\n_(+${omitted} more errors truncated)_\n` : '');
      body = render(kept, scrubbed.length - kept.length);
      // The "+N more" note itself adds bytes — trim until the ENCODED url fits,
      // so the cap holds even with the note appended.
      while (kept.length && encodedLen(title, body) > MAX_ENCODED_URL) {
        kept.pop();
        truncated = true;
        body = render(kept, scrubbed.length - kept.length);
      }
    }
  }

  return { body, truncated };
}

export function buildIssueUrl(input: { title: string; body: string }): string {
  const q = `?labels=${ISSUE_LABEL}` +
    `&title=${encodeURIComponent(input.title)}` +
    `&body=${encodeURIComponent(input.body)}`;
  return ISSUE_BASE + q;
}
