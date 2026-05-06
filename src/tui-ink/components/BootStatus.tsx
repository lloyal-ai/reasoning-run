/**
 * Boot-phase status view. Rendered while uiPhase is 'downloading' or
 * 'loading'. Reuses the same spinner pattern as <PlanningSpinner> — one
 * look across the whole app.
 *
 *   ⠋ Downloading models
 *     ● Qwen3.5-4B Q4_K_M   ████████░░░░  42% · 1.1 GB / 2.6 GB
 *     ● Qwen3-Reranker 0.6B Q8_0  (queued)
 *
 *   ⠋ Loading weights…
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AppState, DownloadStatus } from '../state';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';

export const BootStatus = memo(function BootStatus({
  state,
}: {
  state: AppState;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, []);

  if (state.uiPhase === 'boot_error') {
    const err = state.bootError;
    const kind = err?.kind ?? 'llm';
    const failedLabel = kind === 'llm' ? 'LLM' : 'reranker';
    const primaryCmd = kind === 'llm' ? '/model' : '/reranker';
    const secondaryCmd = kind === 'llm' ? '/reranker' : '/model';
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="red" bold>✗ Boot failed ({failedLabel})</Text>
        <Box paddingLeft={2}>
          <Text>{err?.message ?? 'Unknown error'}</Text>
        </Box>
        <Box paddingLeft={2} marginTop={1}>
          <Text dimColor>
            Type <Text color="cyan">{primaryCmd} </Text>
            <Text dimColor>&lt;path-to-gguf&gt;</Text>
            <Text dimColor> to use a local {failedLabel}, or </Text>
            <Text color="cyan">{secondaryCmd}</Text>
            <Text dimColor> for the other, or </Text>
            <Text color="cyan">/quit</Text>
            <Text dimColor> to exit.</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  if (state.uiPhase === 'downloading') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
          <Text bold>Downloading models</Text>
        </Box>
        {state.downloads.map((d) => (
          <DownloadLine key={d.id} item={d} />
        ))}
      </Box>
    );
  }

  // uiPhase === 'loading'
  return (
    <Box marginBottom={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
      <Text bold>{state.loadingLabel ?? 'Loading…'}</Text>
    </Box>
  );
});

const DownloadLine = memo(function DownloadLine({
  item,
}: {
  item: DownloadStatus;
}): React.ReactElement {
  const pct = item.total > 0 ? Math.min(100, Math.floor((item.got / item.total) * 100)) : 0;
  const width = 16;
  const filled = Math.floor((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);

  // Visual states (collapsed into 3 to keep frames stable):
  //   - done:   ✓ + total bytes
  //   - active: ● + bar + progress + host (must have url so we know which
  //             mirror is serving — also confirms bytes are flowing)
  //   - else:   ○ + "queued · {total}"
  //
  // Notably, `started: true` ALONE doesn't promote to active — there's a
  // brief window between download:start and the first download:progress
  // where started=true but no bytes have arrived. Ink can leak that frame
  // to scrollback during the boot → downloading uiPhase transition; if the
  // leaked frame visually matches "queued", it's indistinguishable and the
  // ghost-row artifact disappears.
  const host = item.url ? hostOf(item.url) : null;
  const isActive = item.started && host !== null;
  const glyph = item.done ? '✓ ' : isActive ? '● ' : '○ ';
  const glyphColor = item.done ? 'green' : isActive ? 'cyan' : undefined;
  const dim = !isActive && !item.done;

  return (
    <Box paddingLeft={2}>
      <Text color={glyphColor} dimColor={dim}>{glyph}</Text>
      <Text dimColor={dim}>{item.label.padEnd(28)}  </Text>
      {item.done ? (
        <Text dimColor>{fmtBytes(item.got)}</Text>
      ) : isActive ? (
        <>
          <Text color="cyan">{bar}</Text>
          <Text>  {String(pct).padStart(2)}% · {fmtBytes(item.got)} / {fmtBytes(item.total)}</Text>
          <Text dimColor>  · {host}</Text>
        </>
      ) : (
        <Text dimColor>queued · {fmtBytes(item.total)}</Text>
      )}
    </Box>
  );
});

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return `${n} B`;
}
