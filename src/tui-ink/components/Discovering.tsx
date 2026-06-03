/**
 * Discovering view — the pre-flight recon agents probing sources, rendered
 * live and SIDE BY SIDE, mirroring flat-mode research (Narrative): one Column
 * per source, laid out in a row (with a vertical fallback when the terminal is
 * too narrow). The user watches each source's probe happen in its own column
 * instead of a silent spinner. Renders the agents in `reconAgentIds`; the
 * planner's `query` event clears them at the discovering → planning hand-off.
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';
import { Column } from './Column';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';
import { useTerminalSize } from '../hooks/useElapsed';

// Tuned to match Narrative's flat layout so recon and research read the same.
const CHROME_ROWS = 18;
const MIN_COLUMN_WIDTH = 26;
const MIN_BODY_ROWS = 10;

export const Discovering = memo(function Discovering({
  state,
}: {
  state: AppState;
}): React.ReactElement {
  const [cols, rows] = useTerminalSize();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, []);

  const agents = state.reconAgentIds
    .map((id) => state.agents.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a);

  const n = agents.length;
  const bodyHeight = Math.max(MIN_BODY_ROWS, rows - CHROME_ROWS);

  // Flat layout: split the width into n equal columns; fall back to vertical
  // stacking when even the minimum-width columns won't fit horizontally.
  const usable = n > 0 ? Math.max(MIN_COLUMN_WIDTH * n, cols - 4) : 0;
  const columnWidth = n > 0 ? Math.max(MIN_COLUMN_WIDTH, Math.floor(usable / n) - 1) : 0;
  const fitsHorizontal = n > 0 && columnWidth * n + n <= cols;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{state.query}</Text>
      <Box marginTop={1}>
        <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
        <Text dimColor>Discovering which sources cover this…</Text>
      </Box>

      {fitsHorizontal && (
        <Box flexDirection="row" marginTop={1}>
          {agents.map((agent) => (
            <Column
              key={agent.id}
              agent={agent}
              headerPrefix="Recon"
              bodyHeight={bodyHeight}
              width={columnWidth}
            />
          ))}
        </Box>
      )}

      {n > 0 && !fitsHorizontal && (
        <Box flexDirection="column" marginTop={1}>
          {agents.map((agent) => (
            <Column
              key={agent.id}
              agent={agent}
              headerPrefix="Recon"
              bodyHeight={Math.max(MIN_BODY_ROWS, Math.floor(bodyHeight / n))}
            />
          ))}
        </Box>
      )}
    </Box>
  );
});
