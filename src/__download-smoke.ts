/**
 * Model catalog + resolveModelPath smoke test.
 *
 *   npx tsx examples/deep-research/__download-smoke.ts
 *
 * Does NOT hit the network. `downloadIfMissing` is covered by manual
 * verification in the plan; automated smoke keeps HF out of the test loop.
 */

import assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MODEL_CATALOG,
  DEFAULT_LLM,
  DEFAULT_RERANKER,
  cacheDir,
  resolveModelPath,
} from './models';

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

check('catalog has at least one llm and one reranker', () => {
  assert.ok(MODEL_CATALOG.find((e) => e.kind === 'llm'));
  assert.ok(MODEL_CATALOG.find((e) => e.kind === 'reranker'));
  assert.equal(DEFAULT_LLM.kind, 'llm');
  assert.equal(DEFAULT_RERANKER.kind, 'reranker');
});

check('catalog: every entry has at least one URL', () => {
  for (const entry of MODEL_CATALOG) {
    assert.ok(
      Array.isArray(entry.urls) && entry.urls.length >= 1,
      `${entry.id}: urls[] must contain at least one entry`,
    );
  }
});

check('catalog: HF URLs use /resolve/main/ (raw bytes), not /blob/', () => {
  for (const entry of MODEL_CATALOG) {
    for (const url of entry.urls) {
      if (!url.includes('huggingface.co')) continue;
      assert.ok(
        url.includes('/resolve/main/'),
        `${entry.id}: HF URL must use /resolve/main/ (got ${url})`,
      );
      assert.ok(
        !url.includes('/blob/'),
        `${entry.id}: HF URL must not use /blob/ (got ${url})`,
      );
    }
  }
});

check('catalog: Huggingface upstream is listed before lloyal mirror', () => {
  for (const entry of MODEL_CATALOG) {
    const lloyalIdx = entry.urls.findIndex((u) => u.includes('lloyal.ai'));
    const hfIdx = entry.urls.findIndex((u) => u.includes('huggingface.co'));
    if (lloyalIdx !== -1 && hfIdx !== -1) {
      assert.ok(
        hfIdx < lloyalIdx,
        `${entry.id}: huggingface.co upstream must precede lloyal.ai mirror`,
      );
    }
  }
});

check('cacheDir: uses XDG_CACHE_HOME when set', () => {
  const prev = process.env.XDG_CACHE_HOME;
  try {
    process.env.XDG_CACHE_HOME = '/tmp/xdg-test';
    assert.equal(cacheDir(), path.join('/tmp/xdg-test', 'lloyal', 'models'));
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  }
});

check('cacheDir: falls back to ~/.cache without XDG_CACHE_HOME', () => {
  const prev = process.env.XDG_CACHE_HOME;
  try {
    delete process.env.XDG_CACHE_HOME;
    assert.equal(cacheDir(), path.join(os.homedir(), '.cache', 'lloyal', 'models'));
  } finally {
    if (prev !== undefined) process.env.XDG_CACHE_HOME = prev;
  }
});

check('resolveModelPath: undefined llm → default LLM cache path + entry', () => {
  const r = resolveModelPath(undefined, 'llm');
  assert.equal(r.entry, DEFAULT_LLM);
  assert.equal(r.path, path.join(cacheDir(), DEFAULT_LLM.filename));
});

check('resolveModelPath: undefined reranker → default reranker cache path + entry', () => {
  const r = resolveModelPath(undefined, 'reranker');
  assert.equal(r.entry, DEFAULT_RERANKER);
  assert.equal(r.path, path.join(cacheDir(), DEFAULT_RERANKER.filename));
});

check('resolveModelPath: catalog id → cache path + matching entry', () => {
  const r = resolveModelPath('qwen3.5-4b-q4', 'llm');
  assert.equal(r.entry?.id, 'qwen3.5-4b-q4');
  assert.equal(r.path, path.join(cacheDir(), 'Qwen3.5-4B-Q4_K_M.gguf'));
});

check('resolveModelPath: explicit filesystem path → echoed as-is, entry null', () => {
  const r = resolveModelPath('/opt/models/custom.gguf', 'llm');
  assert.equal(r.entry, null);
  assert.equal(r.path, '/opt/models/custom.gguf');
});

check('resolveModelPath: relative filesystem path → resolved absolute, entry null', () => {
  const r = resolveModelPath('./models/custom.gguf', 'llm');
  assert.equal(r.entry, null);
  assert.equal(path.isAbsolute(r.path), true);
  assert.ok(r.path.endsWith(path.join('models', 'custom.gguf')));
});

process.stdout.write('---\n');
process.stdout.write(process.exitCode ? 'FAILED\n' : 'all passed\n');
