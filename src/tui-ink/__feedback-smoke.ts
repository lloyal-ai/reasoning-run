/**
 * feedback.ts smoke test — pure helpers for the /feedback command.
 *   npx tsx src/tui-ink/__feedback-smoke.ts
 */
import assert from 'node:assert';
import {
  scrubError,
  feedbackTitle,
  buildFeedbackBody,
  buildIssueUrl,
} from './feedback';
import type { EnvMeta } from './state';

function check(label: string, fn: () => void) {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n`);
    process.stdout.write(`  ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

const ENV: EnvMeta = {
  version: '0.3.1', platform: 'linux', arch: 'x64',
  cpuModel: 'AMD Ryzen 5 3600', nodeVersion: 'v22.0.0', gpu: 'cuda',
};

check('scrubError basenames a POSIX path', () => {
  const out = scrubError('Cannot use /home/jo/matters/secret.gguf: bad', { homeDir: '/home/jo' });
  assert.ok(!out.includes('/home/jo/matters'), out);
  assert.ok(out.includes('secret.gguf'), out);
});

check('scrubError basenames a Windows path', () => {
  const out = scrubError('load C:\\Users\\Jo\\corpus\\brief.md failed', {});
  assert.ok(!out.includes('C:\\Users\\Jo'), out);
  assert.ok(out.includes('brief.md'), out);
});

check('scrubError redacts the session query', () => {
  const out = scrubError('Research failed for "merger of Acme and Beta": HTTP 500', { query: 'merger of Acme and Beta' });
  assert.ok(!out.includes('merger of Acme and Beta'), out);
  assert.ok(out.includes('[query]'), out);
});

check('scrubError strips URL query strings', () => {
  const out = scrubError('GET https://api.x.com/s?key=tvly-abc&q=secret 401', {});
  assert.ok(!out.includes('key=tvly-abc'), out);
});

check('feedbackTitle truncates long messages', () => {
  const t = feedbackTitle('x'.repeat(200));
  assert.ok(t.startsWith('Feedback: '), t);
  assert.ok(t.length <= 'Feedback: '.length + 60, t);
});

check('buildFeedbackBody includes message + environment, omits errors when not consented', () => {
  const { body } = buildFeedbackBody({
    message: 'great tool', env: ENV, config: null, mode: 'flat',
    errors: [{ message: 'boom', at: 0 }], includeErrors: false, scrubCtx: {},
  });
  assert.ok(body.includes('great tool'), body);
  assert.ok(body.includes('AMD Ryzen 5 3600'), body);
  assert.ok(!body.includes('boom'), body);
});

check('buildFeedbackBody includes scrubbed errors when consented', () => {
  const { body } = buildFeedbackBody({
    message: 'hit a crash', env: ENV, config: null, mode: 'deep',
    errors: [{ message: 'createContext STATUS_ILLEGAL_INSTRUCTION', at: 0 }],
    includeErrors: true, scrubCtx: {},
  });
  assert.ok(body.includes('STATUS_ILLEGAL_INSTRUCTION'), body);
});

check('buildFeedbackBody truncates errors first under the cap, keeps message+env', () => {
  // Realistic long error text (with spaces) that the scrubber won't collapse to
  // a single [redacted-token] — so it genuinely exercises error truncation.
  const big = Array.from({ length: 50 }, (_, i) => ({
    message: `research failed on attempt ${i} for host edge ${i}: ` + 'timed out waiting '.repeat(40),
    at: 0,
  }));
  const { body, truncated } = buildFeedbackBody({
    message: 'short note', env: ENV, config: null, mode: 'flat',
    errors: big, includeErrors: true, scrubCtx: {},
  });
  assert.equal(truncated, true);
  assert.ok(body.includes('short note'), 'message kept');
  assert.ok(body.includes('AMD Ryzen 5 3600'), 'env kept');
  assert.ok(/truncated/i.test(body), 'truncation marker present');
});

check('buildIssueUrl encodes and stays under GitHub cap', () => {
  const url = buildIssueUrl({ title: 'Feedback: hi', body: '## x\nbody & more <stuff>' });
  assert.ok(url.startsWith('https://github.com/lloyal-ai/reasoning-run/issues/new?'), url);
  assert.ok(url.includes('labels=feedback'), url);
  assert.ok(url.includes('title='), url);
  assert.ok(url.includes('body='), url);
  assert.ok(!url.includes(' '), 'no raw spaces');
});

// ── Hardening (post-review): secret scrubbing, URL handling, cap, per-error query ──

check('scrubError redacts provider API keys', () => {
  assert.ok(!scrubError('Tavily auth failed: invalid key tvly-abc123def456', {}).includes('tvly-abc123def456'));
  assert.ok(!scrubError('OpenAI sk-proj-ABCDEFGH12345678 rejected', {}).includes('sk-proj-ABCDEFGH12345678'));
});

check('scrubError redacts KEY=VALUE secret env fragments', () => {
  assert.ok(!scrubError('env TAVILY_API_KEY=tvly-xyz9876543210 was set', {}).includes('tvly-xyz9876543210'));
  assert.ok(!scrubError('used key=tvly-abc12345678 today', {}).includes('tvly-abc12345678'));
});

check('scrubError redacts JWT and bearer tokens', () => {
  assert.ok(!scrubError('token eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM rejected', {}).includes('eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM'));
  assert.ok(!scrubError('Authorization: abcDEF123456789 denied', {}).includes('abcDEF123456789'));
});

check('scrubError collapses URLs to origin (drops path + query, no mangle)', () => {
  const out = scrubError('GET https://api.x.com/v1/users/12345?token=SEKRET99 -> 500', {});
  assert.ok(out.includes('https://api.x.com'), out);
  assert.ok(!out.includes('SEKRET99'), out);
  assert.ok(!out.includes('/v1/users/12345'), out);
});

check('scrubError homeDir matches on path boundary only (no sibling mangling)', () => {
  const out = scrubError('/home/joanna/report.md failed', { homeDir: '/home/jo' });
  assert.ok(!out.includes('~anna'), out);
  assert.ok(out.includes('report.md'), out);
});

check('buildFeedbackBody encoded URL never exceeds the cap (note included)', () => {
  const big = Array.from({ length: 200 }, (_, i) => ({
    message: `error ${i}: ` + 'connection reset by peer '.repeat(20), at: 0,
  }));
  const { body } = buildFeedbackBody({
    message: 'note', env: ENV, config: null, mode: 'flat',
    errors: big, includeErrors: true, scrubCtx: {},
  });
  const url = buildIssueUrl({ title: 'Feedback: note', body });
  assert.ok(url.length <= 7000, `encoded url length ${url.length} must be <= 7000`);
});

check('buildFeedbackBody scrubs each error against its own captured query', () => {
  const { body } = buildFeedbackBody({
    message: 'm', env: ENV, config: null, mode: 'flat',
    errors: [{ message: 'failed on secret-matter-A', at: 0, query: 'secret-matter-A' }],
    includeErrors: true, scrubCtx: { query: 'a-different-current-query' },
  });
  assert.ok(!body.includes('secret-matter-A'), body);
});

// ── Red-team round 2: URL creds, prefix-less secrets, unicode crash, cap ──

check('scrubError strips URL/connection-string userinfo credentials (any scheme)', () => {
  assert.ok(!scrubError('could not read https://kazim:hunter2SECRET@github.com/x.git', {}).includes('hunter2SECRET'));
  assert.ok(!scrubError('connect postgresql://dbuser:dbP4ssw0rd@10.0.0.5:5432/corpusdb failed', {}).includes('dbP4ssw0rd'));
  assert.ok(!scrubError('redis://default:redisPassw0rd@cache.internal:6379 down', {}).includes('redisPassw0rd'));
  const ipv6 = scrubError('https://user:secretpw@[2001:db8::1]:8443/x error', {});
  assert.ok(!ipv6.includes('secretpw'), ipv6);
});

check('scrubError redacts prefix-less secrets (hex, base64, uuid)', () => {
  assert.ok(!scrubError('auth failed for da39a3ee5e6b4b0d3255bfef95601890afd80709 retry', {}).includes('da39a3ee5e6b4b0d3255bfef95601890afd80709'));
  assert.ok(!scrubError('session 550e8400-e29b-41d4-a716-446655440000 invalid', {}).includes('550e8400-e29b-41d4-a716-446655440000'));
  assert.ok(!scrubError('blob aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBibG9i seen', {}).includes('aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBibG9i'));
});

check('scrubError redacts KEY:VALUE (colon) and password-after-colon', () => {
  assert.ok(!scrubError('config myApiKey: hunter2secretvalue here', {}).includes('hunter2secretvalue'));
  assert.ok(!scrubError('db password: p@ssw0rdXYZ refused', {}).includes('p@ssw0rdXYZ'));
});

check('scrubError redacts basic-auth shapes (curl -u, user:pass@host)', () => {
  assert.ok(!scrubError('curl -u admin:SuperSecretCurlPw https://x', {}).includes('SuperSecretCurlPw'));
  assert.ok(!scrubError('auth kazim:hunter2pw@internal-host failed', {}).includes('hunter2pw'));
});

check('scrubError does not over-redact ordinary colon text (time, ratios)', () => {
  assert.ok(scrubError('completed at 12:30:45 with ratio 3:4', {}).includes('12:30:45'));
});

check('scrubError matches query case-insensitively and across whitespace', () => {
  const out = scrubError('failed: "WHAT IS THE MERGER PRICE"', { query: 'what is   the merger price' });
  assert.ok(!/MERGER PRICE/.test(out), out);
});

check('scrubError preserves non-secret diagnostic tokens (no over-redaction)', () => {
  // underscore-y constant must survive (it is the headline crash signal)
  assert.ok(scrubError('createContext STATUS_ILLEGAL_INSTRUCTION at init', {}).includes('STATUS_ILLEGAL_INSTRUCTION'));
});

check('scrubError does not crash on a long emoji error and stays encodeable', () => {
  const out = scrubError('💥'.repeat(400) + ' boom', {});
  assert.equal(typeof out, 'string');
  assert.doesNotThrow(() => encodeURIComponent(out));
});

check('buildFeedbackBody never throws on emoji and respects cap', () => {
  const { body } = buildFeedbackBody({
    message: 'A' + '😀'.repeat(5000), env: ENV, config: null, mode: 'flat',
    errors: [], includeErrors: false, scrubCtx: {},
  });
  const url = buildIssueUrl({ title: feedbackTitle('A'), body });
  assert.ok(url.length <= 7000, `len ${url.length}`);
  assert.doesNotThrow(() => decodeURIComponent(url));
});

check('buildFeedbackBody message-marker truncation holds the cap across the boundary band', () => {
  for (let n = 6800; n <= 7200; n += 13) {
    const msg = 'Q'.repeat(n);
    const { body } = buildFeedbackBody({
      message: msg, env: ENV, config: null, mode: 'deep',
      errors: [], includeErrors: false, scrubCtx: {},
    });
    const url = buildIssueUrl({ title: feedbackTitle(msg), body });
    assert.ok(url.length <= 7000, `n=${n} len=${url.length}`);
  }
});
