/**
 * GPU/model arg-selection smoke — builds the esbuild bundle, then spawns
 * the real entry (`bin/run.js`) with the invalid-argument matrix and
 * asserts exit codes + stderr. Every case here exits during flag
 * validation, BEFORE any model load, so this stays fast enough for the
 * smoke stage.
 *
 * The happy-path selection (CLI > env > file > default) is covered at the
 * loadConfig layer in tui-ink/__config-smoke.ts; the fail-loud boot on an
 * unavailable explicit variant needs real weights and lives in the manual
 * verification gate.
 *
 *   npx tsx src/__gpu-args-smoke.ts
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname is undefined under tsx's CJS transform — derive it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'bin', 'run.js');

// The raw src/harness.ts can't run under tsx (`.eta` imports only resolve via
// esbuild's --loader:.eta=text), so this smoke exercises the real bundle.
// Build it first — esbuild is ~25ms, and CI runs smokes before its build
// step, so the bundle may be stale or absent here.
{
  const b = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (b.status !== 0) {
    process.stdout.write(`FAIL bundle build for arg smoke\n${b.stderr}\n`);
    process.exit(1);
  }
}

function run(args: string[]): { status: number | null; stderr: string } {
  const env = { ...process.env };
  // Isolate from ambient backend config so assertions are deterministic.
  delete env.LLOYAL_GPU;
  delete env.LLOYAL_NO_FALLBACK;
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // Every case exits during flag validation, before any model load; the
    // timeout is a hang-guard, not an expected duration.
    timeout: 30_000,
    env,
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n  ${(err as Error).message}\n`);
  }
}

check('--gpu metal exits 1 with the Metal-is-automatic message', () => {
  const r = run(['--gpu', 'metal', '--jsonl', '--query', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Metal is automatic on macOS/);
});

check('--gpu <unknown> exits 1 with the valid-values message', () => {
  const r = run(['--gpu', 'nonsense', '--jsonl', '--query', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid --gpu: nonsense/);
  assert.match(r.stderr, /"cuda", "vulkan" or "default"/);
});

check('--model + conflicting positional exits 1', () => {
  const r = run(['--model', '/a.gguf', '/b.gguf', '--jsonl', '--query', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Conflicting model paths/);
});

if (failures > 0) {
  process.stdout.write(`---\n${failures} failed\n`);
  process.exit(1);
}
process.stdout.write('---\nall passed\n');
