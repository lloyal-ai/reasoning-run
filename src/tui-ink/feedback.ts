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

export function scrubError(message: string, ctx: ScrubCtx): string {
  let s = message;
  // 1. Redact the session query verbatim, if present.
  if (ctx.query && ctx.query.trim()) {
    s = s.split(ctx.query).join('[query]');
  }
  // 2. Strip URL query strings (may carry keys / search terms).
  s = s.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1');
  // 3. Configured paths → basename.
  for (const p of ctx.paths ?? []) {
    if (p && s.includes(p)) s = s.split(p).join(basename(p));
  }
  // 4. Home dir → ~.
  if (ctx.homeDir && ctx.homeDir.trim()) s = s.split(ctx.homeDir).join('~');
  // 5. Remaining absolute paths (POSIX + Windows + UNC) → basename.
  s = s.replace(/(?:[A-Za-z]:\\|\\\\|\/)[^\s:?"<>|]+/g, (m) => basename(m));
  // 6. Length bound.
  if (s.length > MAX_ERROR_LEN) s = s.slice(0, MAX_ERROR_LEN) + '…';
  return s.trim();
}

export function feedbackTitle(message: string): string {
  const firstLine = (message.split('\n')[0] ?? '').trim() || 'feedback';
  const clipped = firstLine.length > MAX_TITLE ? firstLine.slice(0, MAX_TITLE) : firstLine;
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

  // 1. Message + environment always fit; truncate the message if even that overflows.
  let msg = message;
  while (encodedLen(title, header(msg)) > MAX_ENCODED_URL && msg.length > 0) {
    truncated = true;
    msg = msg.slice(0, Math.max(0, msg.length - 64));
  }
  if (truncated) msg = msg.replace(/\s*$/, '') + '\n…(truncated)';
  let body = header(msg);

  // 2. Add scrubbed errors greedily while they fit.
  if (includeErrors && errors.length) {
    const scrubbed = errors.map((e) => scrubError(e.message, scrubCtx)).filter(Boolean);
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
      const omitted = scrubbed.length - kept.length;
      const note = omitted > 0 ? `\n_(+${omitted} more errors truncated)_\n` : '';
      body = header(msg) +
        `\n## Errors (${kept.length})\n` +
        kept.map((m, j) => `${j + 1}. ${m}`).join('\n') + '\n' + note;
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
