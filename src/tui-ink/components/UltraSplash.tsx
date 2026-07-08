/**
 * UltraSplash — the brief "ultra selected" flourish. Mounted by the Composer for
 * ~1.5s when the effort slider commits `ultra`, then auto-dismisses back to the
 * query field. Purely local, transient UI — no reducer / AppState involvement.
 *
 * Built from the same primitives as PlanningSpinner (a `memo` + `useState(frame)`
 * + `useEffect(setInterval(…, SPINNER_TICK_MS))` over SPINNER_FRAMES) plus a
 * `useElapsed` progress bar and a one-shot dismiss timer. Magenta throughout —
 * the ultra tier's signature colour, carried over from EffortSlider.
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';
import { useElapsed } from '../hooks/useElapsed';

/** How long the splash holds before dismissing. */
const DURATION_MS = 1500;
/** Progress-bar cell count. */
const BAR_WIDTH = 28;

export interface UltraSplashProps {
  /** Fired once when the splash has run its course (Composer clears it). */
  onDone: () => void;
}

export const UltraSplash = memo(function UltraSplash({
  onDone,
}: UltraSplashProps): React.ReactElement {
  // Braille frame loop — identical cadence to PlanningSpinner / RunStatusLine.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, []);

  // Progress bar fills over DURATION_MS (useElapsed re-renders every 250ms).
  const [startedAt] = useState(() => Date.now());
  const elapsed = useElapsed(startedAt, true);
  const progress = Math.min(1, elapsed / DURATION_MS);
  const filled = Math.round(progress * BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);

  // One-shot dismiss. Fires after the hold, independent of the render clock.
  useEffect(() => {
    const id = setTimeout(onDone, DURATION_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const spin = SPINNER_FRAMES[frame];
  return (
    <Box
      flexDirection="column"
      alignItems="center"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      paddingY={1}
    >
      <Text color="magenta" bold>
        {spin}  ✦ ULTRA EFFORT ✦  {spin}
      </Text>
      <Box marginTop={1}>
        <Text color="magenta">{bar}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>10 tasks · longest runs · maximum context</Text>
      </Box>
    </Box>
  );
});
