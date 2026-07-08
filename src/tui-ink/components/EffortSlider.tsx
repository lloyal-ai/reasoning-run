/**
 * EffortSlider — the composer's Faster↔Smarter run-effort control, opened via
 * the `/effort` slash command (Composer `field === 'effort'`). Renders the tier
 * ladder `low · medium · high · ultra` as a 4-detent track with the selected
 * tier highlighted (`ultra` in magenta) and a caption for the current pick.
 *
 * A pure controlled widget — same seam as the inline `/model` / `/output`
 * editors: it owns only local selection state and reports out via `onCommit` /
 * `onCancel`; the Composer does the `set_effort` dispatch and the splash. That
 * command persists `defaults.effort` to harness.json and echoes `config:updated`
 * (main.ts's set_effort handler), so the committed tier applies to every
 * subsequent query.
 *
 * Keyboard (matches the inline editors — Esc exits, Ctrl+C inert mid-control):
 *   ←/→  move selection   ·   ⏎ apply   ·   Esc cancel
 */

import React, { memo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { EFFORT_ORDER, type Effort } from '../../effort-presets';

/** Per-tier accent hue. `ultra` is magenta (from colors.ts's agent palette) —
 *  the ceiling tier's signature colour, carried through to the splash. */
const TIER_HUE: Record<Effort, 'green' | 'cyan' | 'yellow' | 'magenta'> = {
  low: 'green',
  medium: 'cyan',
  high: 'yellow',
  ultra: 'magenta',
};

/** One-line description of what each tier trades off. `ultra`'s doubles as the
 *  cost warning (longest runs / most tokens). */
const TIER_CAPTION: Record<Effort, string> = {
  low: 'Quickest — shallow, fewest tasks, strict on-topic retrieval.',
  medium: 'Balanced — moderate fan-out with recovery headroom banked.',
  high: 'Thorough — the default; hunts novel facts the longest.',
  ultra: 'Maximum — 10 tasks, longest runs. May use excessive tokens.',
};

export interface EffortSliderProps {
  /** The currently-persisted effort — where the marker starts. */
  current: Effort;
  /** Enter with `tier` selected. The Composer dispatches set_effort + closes. */
  onCommit: (tier: Effort) => void;
  /** Esc — leave the control untouched (no dispatch), back to the query field. */
  onCancel: () => void;
}

export const EffortSlider = memo(function EffortSlider({
  current,
  onCommit,
  onCancel,
}: EffortSliderProps): React.ReactElement {
  const startIdx = Math.max(0, EFFORT_ORDER.indexOf(current));
  const [idx, setIdx] = useState(startIdx);
  // `idx` IS the source of truth (React state) and drives the render. But Ink's
  // `useInput` callback closes over a stale render: the `idx` *read* inside it
  // stays frozen at the mount value even as the functional `setIdx` updater
  // advances the live selection. Writes escape that (setIdx's `i => …` form sees
  // latest state); a *read* in the handler cannot — so `Enter` reads the live
  // index from a ref synced each render, else it always commits the start tier.
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const selected = EFFORT_ORDER[idx];
  const last = EFFORT_ORDER.length - 1;

  useInput((_input, key) => {
    if (key.leftArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.rightArrow) {
      setIdx((i) => Math.min(last, i + 1));
      return;
    }
    if (key.return) {
      onCommit(EFFORT_ORDER[idxRef.current]);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
  });

  return (
    <Box flexDirection="column">
      {/* Track: Effort · Faster ◉──○──○──○ Smarter (selected node = tier hue). */}
      <Box>
        <Text bold>Effort  </Text>
        <Text dimColor>Faster  </Text>
        {EFFORT_ORDER.map((tier, i) => (
          <React.Fragment key={tier}>
            <Text
              color={i === idx ? TIER_HUE[selected] : undefined}
              dimColor={i !== idx}
              bold={i === idx}
            >
              {i === idx ? '◉' : '○'}
            </Text>
            {i < last ? <Text dimColor>──</Text> : null}
          </React.Fragment>
        ))}
        <Text dimColor>  Smarter</Text>
      </Box>

      {/* Tier labels — the selected one as a filled pill (same grammar as the
          composer's SubmitButton), ultra reading magenta-on-black. */}
      <Box marginTop={0}>
        {EFFORT_ORDER.map((tier, i) => {
          const body = ` ${tier} `;
          if (i === idx) {
            return (
              <Text key={tier} backgroundColor={TIER_HUE[tier]} color="black" bold>
                {body}
              </Text>
            );
          }
          return (
            <Text key={tier} dimColor>
              {body}
            </Text>
          );
        })}
      </Box>

      {/* Caption for the current pick — ultra reads magenta as a soft warning. */}
      <Box marginTop={0}>
        <Text color={selected === 'ultra' ? 'magenta' : undefined} dimColor={selected !== 'ultra'}>
          {TIER_CAPTION[selected]}
        </Text>
      </Box>
    </Box>
  );
});
