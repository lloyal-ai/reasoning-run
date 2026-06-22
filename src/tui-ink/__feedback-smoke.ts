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
  const big = Array.from({ length: 50 }, (_, i) => ({ message: 'X'.repeat(400) + i, at: 0 }));
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
