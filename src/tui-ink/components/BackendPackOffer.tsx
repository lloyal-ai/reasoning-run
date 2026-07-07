/**
 * BackendPackOffer — boot-time dialog offered when a CUDA GPU is probed
 * and a signed full-arch backend pack is available for it (uiPhase
 * 'backend_pack_offer').
 *
 * Buttons-only, mirroring the 0.4.2 run-controls keymap:
 *   ←→ / Tab   switch between Download and Not now
 *   ⏎          confirm the focused pill
 *
 * Download → accept_backend_pack: main.ts streams the archive(s) through
 * the standard download UI, then boot continues on the pack.
 * Not now → decline_backend_pack: persists model.backendPack=false — the
 * offer never re-fires (re-enable by editing harness.json).
 *
 * stateRef mirrors focus into a ref each render — Ink 7 + React 19's
 * useEffectEvent leaves useInput closures stale (see PlanReview).
 */

import React, { memo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState } from '../state';
import { useCommand } from '../hooks/useCommand';

function fmtGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export interface BackendPackOfferProps {
  state: AppState;
}

export const BackendPackOffer = memo(function BackendPackOffer({
  state,
}: BackendPackOfferProps): React.ReactElement | null {
  const dispatch = useCommand();
  const offer = state.backendPackOffer;
  const [focused, setFocused] = useState<'download' | 'later'>('download');
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow || key.tab) {
      setFocused((f) => (f === 'download' ? 'later' : 'download'));
      return;
    }
    if (key.return) {
      dispatch(
        focusedRef.current === 'download'
          ? { type: 'accept_backend_pack' }
          : { type: 'decline_backend_pack' },
      );
    }
  });

  if (!offer) return null;
  const totalBytes = offer.sizeBytes + (offer.needsRuntime ? offer.runtimeSizeBytes : 0);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>GPU backend pack available</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Detected <Text bold>{offer.gpuName}</Text>. A signed full-architecture CUDA
          pack ({fmtGB(totalBytes)}
          {offer.needsRuntime ? ', incl. CUDA runtime' : ''}) runs native kernels on
          this GPU instead of the portable build.
        </Text>
        {offer.reasons.slice(0, 3).map((r, i) => (
          <Text key={i} dimColor>
            {'  '}· {r}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} gap={2}>
        <Text
          bold
          inverse={focused === 'download'}
          color={focused === 'download' ? 'green' : undefined}
        >
          {' Download '}
        </Text>
        <Text bold inverse={focused === 'later'}>
          {' Not now '}
        </Text>
        <Text dimColor>←→ switch · ⏎ confirm</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Not now persists to harness.json — the offer won't repeat.
        </Text>
      </Box>
    </Box>
  );
});
