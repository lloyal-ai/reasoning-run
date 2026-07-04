/**
 * Config smoke test — verifies load precedence, env-guarded writes, and
 * auto-gitignore behavior against a scratch tmpdir.
 *
 *   npx tsx examples/shared/tui-ink/__config-smoke.ts
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, saveConfig } from './config';

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

function scratchDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-smoke-${label}-`));
  return dir;
}

check('load: missing file → defaults', () => {
  const dir = scratchDir('missing');
  const { config, origin, loadedFromFile } = loadConfig(
    path.join(dir, 'harness.json'),
    {},
    {},
  );
  assert.equal(loadedFromFile, false);
  assert.equal(config.defaults.reasoningMode, 'flat');
  assert.deepEqual(config.apps, {});
  assert.equal(origin.reasoningMode, 'default');
});

check('load: per-app config map round-trips from file', () => {
  const dir = scratchDir('apps');
  const file = path.join(dir, 'harness.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      apps: { web: { tavilyKey: 'tvly-file' } },
      defaults: { reasoningMode: 'flat' },
    }),
  );
  const { config, origin } = loadConfig(file, {}, {});
  assert.equal(config.apps.web.tavilyKey, 'tvly-file');
  assert.equal(config.defaults.reasoningMode, 'flat');
  assert.equal(origin.reasoningMode, 'file');
});

check('load: path-shaped app values get ~-expanded / made absolute', () => {
  const dir = scratchDir('apppaths');
  const file = path.join(dir, 'harness.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      apps: { corpus: { corpusPath: '/tmp/abs' } },
    }),
  );
  const { config } = loadConfig(file, {}, {});
  assert.equal(config.apps.corpus.corpusPath, '/tmp/abs'); // absolute is idempotent
});

check('load: precedence CLI > env > file > default (harness fields)', () => {
  const dir = scratchDir('prec');
  const file = path.join(dir, 'harness.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, defaults: { reasoningMode: 'flat' } }),
  );
  const { config, origin } = loadConfig(file, { reasoningMode: 'deep' }, {});
  assert.equal(config.defaults.reasoningMode, 'deep');
  assert.equal(origin.reasoningMode, 'cli');
});

check('save: writes app config under apps[name], then reload returns it', () => {
  const dir = scratchDir('save');
  const file = path.join(dir, 'harness.json');
  saveConfig({ apps: { web: { tavilyKey: 'tvly-abc' } } }, file, {});
  assert.equal(fs.existsSync(file), true);
  const { config } = loadConfig(file, {}, {});
  assert.equal(config.apps.web.tavilyKey, 'tvly-abc');
});

check('save: whole-replaces one app without clobbering others', () => {
  const dir = scratchDir('merge');
  const file = path.join(dir, 'harness.json');
  saveConfig({ apps: { web: { tavilyKey: 'tvly-a' } } }, file, {});
  saveConfig({ apps: { corpus: { corpusPath: '/tmp/z' } } }, file, {});
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.apps.web.tavilyKey, 'tvly-a'); // unrelated app preserved
  assert.equal(raw.apps.corpus.corpusPath, '/tmp/z');
  // Re-saving web with an empty object whole-replaces (clears) just web.
  saveConfig({ apps: { web: {} } }, file, {});
  const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw2.apps.web, {});
  assert.equal(raw2.apps.corpus.corpusPath, '/tmp/z'); // corpus untouched
});

check('save: first save in git repo appends to .gitignore', () => {
  const dir = scratchDir('git');
  execSync('git init -q', { cwd: dir });
  const file = path.join(dir, 'harness.json');
  const r = saveConfig({ defaults: { reasoningMode: 'flat' } as never }, file, {});
  assert.equal(r.gitignored, true);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /\bharness\.json\b/);
});

check('save: second save does not re-append to .gitignore', () => {
  const dir = scratchDir('git-noop');
  execSync('git init -q', { cwd: dir });
  const file = path.join(dir, 'harness.json');
  saveConfig({ defaults: { reasoningMode: 'flat' } as never }, file, {});
  const r2 = saveConfig({ apps: { corpus: { corpusPath: '/a' } } }, file, {});
  assert.equal(r2.gitignored, false);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  const matches = gi.match(/\bharness\.json\b/g) ?? [];
  assert.equal(matches.length, 1);
});

check('nCtx precedence: CLI > env > file > default(undefined)', () => {
  const dir = scratchDir('nctx');
  const file = path.join(dir, 'harness.json');

  // No config, no env, no CLI → undefined.
  let result = loadConfig(file, {}, {});
  assert.equal(result.config.model.nCtx, undefined);
  assert.equal(result.origin.nCtx, 'default');

  // File supplies → reads file.
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, model: { nCtx: 16384 } }),
  );
  result = loadConfig(file, {}, {});
  assert.equal(result.config.model.nCtx, 16384);
  assert.equal(result.origin.nCtx, 'file');

  // Env overrides file.
  result = loadConfig(file, {}, { LLAMA_CTX_SIZE: '24576' });
  assert.equal(result.config.model.nCtx, 24576);
  assert.equal(result.origin.nCtx, 'env');

  // CLI overrides env.
  result = loadConfig(
    file,
    { nCtx: 65536 },
    { LLAMA_CTX_SIZE: '24576' },
  );
  assert.equal(result.config.model.nCtx, 65536);
  assert.equal(result.origin.nCtx, 'cli');

  // Bogus env silently ignored (no parseInt NaN leaking through).
  result = loadConfig(file, {}, { LLAMA_CTX_SIZE: 'not-a-number' });
  assert.equal(result.config.model.nCtx, 16384); // fell back to file
  assert.equal(result.origin.nCtx, 'file');
});

check('nCtx save round-trip', () => {
  const dir = scratchDir('nctx-save');
  const file = path.join(dir, 'harness.json');
  saveConfig({ model: { nCtx: 65536 } }, file, {});
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.model.nCtx, 65536);
  const { config } = loadConfig(file, {}, {});
  assert.equal(config.model.nCtx, 65536);
});

check('gpu precedence: CLI > env(LLOYAL_GPU) > file > default(undefined)', () => {
  const dir = scratchDir('gpu');
  const file = path.join(dir, 'harness.json');

  // No config, no env, no CLI → undefined.
  let result = loadConfig(file, {}, {});
  assert.equal(result.config.model.gpu, undefined);
  assert.equal(result.origin.gpu, 'default');

  // File supplies → reads file.
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, model: { gpu: 'vulkan' } }),
  );
  result = loadConfig(file, {}, {});
  assert.equal(result.config.model.gpu, 'vulkan');
  assert.equal(result.origin.gpu, 'file');

  // Env overrides file.
  result = loadConfig(file, {}, { LLOYAL_GPU: 'cuda' });
  assert.equal(result.config.model.gpu, 'cuda');
  assert.equal(result.origin.gpu, 'env');

  // CLI overrides env.
  result = loadConfig(file, { gpu: 'default' }, { LLOYAL_GPU: 'cuda' });
  assert.equal(result.config.model.gpu, 'default');
  assert.equal(result.origin.gpu, 'cli');

  // Bogus env value silently ignored (falls back to file).
  result = loadConfig(file, {}, { LLOYAL_GPU: 'metal' });
  assert.equal(result.config.model.gpu, 'vulkan');
  assert.equal(result.origin.gpu, 'file');

  // Bogus FILE value also ignored (hand-edited harness.json).
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, model: { gpu: 'tpu' } }),
  );
  result = loadConfig(file, {}, {});
  assert.equal(result.config.model.gpu, undefined);
  assert.equal(result.origin.gpu, 'default');
});

check('gpu save round-trip', () => {
  const dir = scratchDir('gpu-save');
  const file = path.join(dir, 'harness.json');
  saveConfig({ model: { gpu: 'cuda' } }, file, {});
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.model.gpu, 'cuda');
  const { config, origin } = loadConfig(file, {}, {});
  assert.equal(config.model.gpu, 'cuda');
  assert.equal(origin.gpu, 'file');
});

check('save: empty-string outputDir deletes the key', () => {
  const dir = scratchDir('clear');
  const file = path.join(dir, 'harness.json');
  saveConfig({ sources: { outputDir: '/tmp/out' } }, file, {});
  let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.sources.outputDir, '/tmp/out');

  // Clear outputDir with empty string.
  saveConfig({ sources: { outputDir: '' } }, file, {});
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.sources.outputDir, undefined);
});

check('save: non-git dir → gitignored=false, no .gitignore written', () => {
  const dir = scratchDir('nogit');
  const file = path.join(dir, 'harness.json');
  const r = saveConfig({ apps: { corpus: { corpusPath: '/b' } } }, file, {});
  assert.equal(r.gitignored, false);
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
});

process.stdout.write('---\n');
process.stdout.write(process.exitCode ? 'FAILED\n' : 'all passed\n');
