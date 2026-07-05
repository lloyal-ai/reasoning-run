import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentRuntime, TimelineItem } from '../state';
import { extractStreamingReport } from '../state';
import { colorForLabel } from '../colors';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';

export interface ColumnProps {
  agent: AgentRuntime;
  /** Column header prefix, e.g. "Task 1" for chain or null for flat. */
  headerPrefix: string | null;
  /** Visible body height (rows). Older content scrolls off the top via
   *  Ink's overflow:hidden + justifyContent:flex-end on the body box. */
  bodyHeight: number;
  /** Explicit column width (chars) for flat mode; undefined = fill parent (chain). */
  width?: number;
  /** Cancel-key badge — the digit that cancels this agent (taskIndex + 1).
   *  Rendered dim in the header. null = no badge (deep mode, recon). */
  cancelKey?: number | null;
}

const STATUS_ACTIVE: AgentRuntime['phase'][] = ['thinking', 'content', 'tool'];

function isActive(agent: AgentRuntime): boolean {
  return STATUS_ACTIVE.includes(agent.phase);
}

// ── Per-item renderers ─────────────────────────────────────────

export const ThinkItem = memo(function ThinkItem({
  item,
  color,
}: {
  item: Extract<TimelineItem, { kind: 'think' }>;
  color: string;
}): React.ReactElement {
  const title = item.live
    ? item.body.includes('\n')
      ? titleFromBody(item.body)
      : 'Thinking…'
    : item.title;
  const body = item.live
    ? stripFirstLineIfTitle(item.body)
    : stripFirstLineIfTitle(item.body).trim();
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Box>
        <Text color={color}>✦ </Text>
        <Text bold>{title}</Text>
      </Box>
      {body ? (
        <Box paddingLeft={2}>
          <Text>
            {body}
            {item.live ? '▎' : ''}
          </Text>
        </Box>
      ) : item.live ? (
        <Box paddingLeft={2}>
          <Text dimColor>▎</Text>
        </Box>
      ) : null}
    </Box>
  );
});

function titleFromBody(body: string): string {
  const nl = body.indexOf('\n');
  if (nl <= 0) return 'Thinking…';
  const first = body.slice(0, nl).trim();
  if (!first) return 'Thinking…';
  return first.length > 72 ? first.slice(0, 72).trimEnd() + '…' : first;
}

function stripFirstLineIfTitle(body: string): string {
  const nl = body.indexOf('\n');
  if (nl <= 0) return '';
  return body.slice(nl + 1).trimStart();
}

export const ToolCallItem = memo(function ToolCallItem({
  item,
  pending = false,
  retry = null,
}: {
  item: Extract<TimelineItem, { kind: 'tool_call' }>;
  /** True while the agent is awaiting this tool's result. Drives a
   *  spinner in place of the static glyph. Defaults to false so
   *  FrozenAgentPanel (which renders only completed agents) doesn't
   *  need to pass it. */
  pending?: boolean;
  /** Park-and-retry state for THIS pending call — provider rate-limited,
   *  pool re-executes after a delay. Renders a countdown so the wait is
   *  visibly progress, not a hang. */
  retry?: { retryAt: number; attempt: number } | null;
}): React.ReactElement {
  // Inline spinner state — same pattern as PlanningSpinner.tsx. The
  // interval only runs while pending, then cleans up on tool_result.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, [pending]);

  // Countdown computed at render — the pending spinner interval re-renders
  // every tick, keeping the remaining-seconds display fresh for free.
  const retrySecs = retry ? Math.max(0, Math.ceil((retry.retryAt - Date.now()) / 1000)) : null;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box>
        {pending ? (
          <Text color={retry ? 'yellow' : 'cyan'}>{SPINNER_FRAMES[frame]} </Text>
        ) : (
          <Text dimColor>› </Text>
        )}
        <Text color="cyan">{item.tool}</Text>
        {item.argsSummary ? <Text dimColor>  {item.argsSummary}</Text> : null}
      </Box>
      {pending && retry ? (
        <Box paddingLeft={2}>
          <Text color="yellow">
            rate-limited — retrying in ~{retrySecs}s
            {retry.attempt > 1 ? ` (attempt ${retry.attempt})` : ''}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

export const ToolResultItem = memo(function ToolResultItem({
  item,
}: {
  item: Extract<TimelineItem, { kind: 'tool_result' }>;
}): React.ReactElement {
  const hostChips = item.hosts.length > 0 ? item.hosts.join(' · ') : null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingLeft={2}>
        <Text color="green">✓ </Text>
        <Text>{item.resultCount ?? item.byteLength + 'b'}</Text>
        {typeof item.resultCount === 'number' ? <Text> results</Text> : null}
      </Box>
      {hostChips ? (
        <Box paddingLeft={4}>
          <Text dimColor>{hostChips}</Text>
        </Box>
      ) : item.preview ? (
        <Box paddingLeft={4}>
          <Text dimColor>{item.preview.length > 60 ? item.preview.slice(0, 60) + '…' : item.preview}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

export const ReportItem = memo(function ReportItem({
  item,
  color,
}: {
  item: Extract<TimelineItem, { kind: 'report' }>;
  color: string;
}): React.ReactElement {
  const body = item.body.trim();
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box>
        <Text color={color}>✓ </Text>
        <Text bold>report</Text>
        <Text dimColor> · {item.tokenCount} tok</Text>
      </Box>
      {body ? (
        <Box paddingLeft={2}>
          <Text>{body}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

/** Live report body streaming out of the agent — either the marker-gated
 *  slice of the Hermes tool-call buffer (voluntary report) or the raw
 *  recovery buffer (forced report; no envelope). The caller does that
 *  extraction; this just renders. Cleared by the reducer on tool_call /
 *  report. */
const ContentStream = memo(function ContentStream({
  buffer,
  color,
}: {
  buffer: string;
  color: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box>
        <Text color={color}>▸ </Text>
        <Text dimColor bold>writing report</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>{buffer}▎</Text>
      </Box>
    </Box>
  );
});

// ── Column ─────────────────────────────────────────────────────

/** Rows of chrome inside the column box: header row(s) + optional
 *  description + optional dependency hint. Reserved so the body area
 *  gets the rest of the column's budget. */
const HEADER_ROWS = 3;

/** Header status glyph — four states, matching the desktop card pills:
 *  ● live (agent color) / ◐ recovering (writing forced report) /
 *  ✕ failed (incl. user_cancel) / ✓ done. */
function statusGlyph(agent: AgentRuntime, color: string): React.ReactElement {
  if (agent.recovering) return <Text color="yellow">◐</Text>;
  if (agent.phase === 'failed') return <Text color="red">✕</Text>;
  if (isActive(agent)) return <Text color={color}>●</Text>;
  return <Text color="green">✓</Text>;
}

export const Column = memo(function Column({
  agent,
  headerPrefix,
  bodyHeight,
  width,
  cancelKey = null,
}: ColumnProps): React.ReactElement {
  const color = colorForLabel(agent.label);

  const descText = agent.taskDescription ?? null;

  // Outer column: fixed total height so the narrative row doesn't jitter
  // as content streams. overflow="hidden" honors the measured height via
  // Yoga + Ink's renderer.
  const totalHeight = bodyHeight + HEADER_ROWS;

  // Voluntary reports stream inside Hermes tool-call XML — show only the
  // report body (marker-gated; null until <parameter=result> arrives).
  // Forced recovery streams raw prose with no envelope: use the buffer
  // verbatim. Same branch as the desktop renderer (Work.tsx).
  const liveStream = agent.recovering
    ? agent.contentBuffer
    : extractStreamingReport(agent.contentBuffer);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={totalHeight}
      paddingX={1}
      marginRight={1}
      flexShrink={0}
      overflow="hidden"
    >
      {/* Header */}
      <Box flexShrink={0}>
        {cancelKey != null ? <Text dimColor>[{cancelKey}] </Text> : null}
        {headerPrefix ? <Text dimColor>{headerPrefix} · </Text> : null}
        <Text color={color} bold>{agent.label}</Text>
        <Box flexGrow={1} />
        {statusGlyph(agent, color)}
      </Box>
      {descText ? (
        <Text dimColor>{descText}</Text>
      ) : null}
      {agent.dependencyHint ? (
        <Text dimColor>↑ {agent.dependencyHint}</Text>
      ) : null}

      {/* Body — grows to fill remaining column height; newest content pinned
        to the bottom via justifyContent="flex-end"; older content overflows
        at the top and is clipped by the outer overflow="hidden". */}
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-end"
        overflow="hidden"
      >
        {agent.timeline.map((item) => {
          if (item.kind === 'think') {
            return <ThinkItem key={item.id} item={item} color={color} />;
          }
          if (item.kind === 'tool_call') {
            return (
              <ToolCallItem
                key={item.id}
                item={item}
                pending={agent.pendingToolCallId === item.id}
                retry={agent.pendingToolCallId === item.id ? agent.retry : null}
              />
            );
          }
          if (item.kind === 'tool_result') {
            return <ToolResultItem key={item.id} item={item} />;
          }
          if (item.kind === 'report') {
            return <ReportItem key={item.id} item={item} color={color} />;
          }
          return null;
        })}
        {liveStream && liveStream.trim() ? (
          <ContentStream buffer={liveStream} color={color} />
        ) : null}
      </Box>
    </Box>
  );
});
