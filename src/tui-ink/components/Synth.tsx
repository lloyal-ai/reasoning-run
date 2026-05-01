import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';

export interface SynthProps {
  state: AppState;
}

const ms = (t: number): string => `${(t / 1000).toFixed(1)}s`;

export function Synth({ state }: SynthProps): React.ReactElement | null {
  const { synth } = state;
  if (!synth.open && !synth.done) return null;

  const header = synth.done ? (
    <Box>
      <Text bold>Synthesis </Text>
      <Text color="green">✓</Text>
      {synth.stats ? (
        <Text dimColor>
          {' '}· {synth.stats.tokens} tok · {synth.stats.toolCalls} tools ·{' '}
          {Number.isFinite(synth.stats.ppl) ? `ppl ${synth.stats.ppl.toFixed(2)} · ` : ''}
          {ms(synth.stats.timeMs)}
        </Text>
      ) : null}
    </Box>
  ) : (
    <Box>
      <Text bold>Synthesis</Text>
      <Text color="cyan"> ●</Text>
    </Box>
  );

  const body = synth.buffer.trim();

  // When synth is done, the body has been pushed to state.scrollback and
  // is rendered via <Static> at the App root. Don't double-render it here —
  // a tall synth body in the dynamic tree pushes the post-complete chrome
  // off-viewport and Ink loses cursor anchoring (the disappearance bug).
  return (
    <Box flexDirection="column" marginBottom={1}>
      {header}
      {synth.open && body ? (
        <Box paddingLeft={2} marginTop={0}>
          <Text>
            {body}▎
          </Text>
        </Box>
      ) : synth.open ? (
        <Box paddingLeft={2}>
          <Text dimColor>▎</Text>
        </Box>
      ) : null}
    </Box>
  );
}
