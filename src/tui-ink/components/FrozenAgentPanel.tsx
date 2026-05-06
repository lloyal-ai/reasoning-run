/**
 * FrozenAgentPanel — renders a finished research agent's timeline in
 * scrollback via Ink's <Static>.
 *
 * Distinct from Column.tsx in two ways:
 *   1. No fixed height / overflow="hidden" — the full timeline renders,
 *      no clipping. Static items get printed once into terminal scrollback.
 *   2. No active-state spinner / live cursor — the panel is frozen at the
 *      moment agent:report fired.
 *
 * Visually matches Column's chrome (border, color, label, description) so
 * the scrollback bundle reads as a continuation of the live panels.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AgentRuntime } from '../state';
import { colorForLabel } from '../colors';
import { ThinkItem, ToolCallItem, ToolResultItem, ReportItem } from './Column';

export interface FrozenAgentPanelProps {
  agent: AgentRuntime;
}

export function FrozenAgentPanel({ agent }: FrozenAgentPanelProps): React.ReactElement {
  const color = colorForLabel(agent.label);
  const descText = agent.taskDescription
    ? agent.taskDescription.length > 80
      ? agent.taskDescription.slice(0, 80) + '…'
      : agent.taskDescription
    : null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      {/* Header */}
      <Box flexShrink={0}>
        <Text color={color} bold>{agent.label}</Text>
        <Box flexGrow={1} />
        <Text color="green">✓</Text>
      </Box>
      {descText ? <Text dimColor>{descText}</Text> : null}
      {agent.dependencyHint ? (
        <Text dimColor>↑ {agent.dependencyHint}</Text>
      ) : null}

      {/* Body — full timeline, no clipping */}
      <Box flexDirection="column">
        {agent.timeline.map((item) => {
          if (item.kind === 'think') {
            return <ThinkItem key={item.id} item={item} color={color} />;
          }
          if (item.kind === 'tool_call') {
            return <ToolCallItem key={item.id} item={item} />;
          }
          if (item.kind === 'tool_result') {
            return <ToolResultItem key={item.id} item={item} />;
          }
          if (item.kind === 'report') {
            return <ReportItem key={item.id} item={item} color={color} />;
          }
          return null;
        })}
      </Box>
    </Box>
  );
}
