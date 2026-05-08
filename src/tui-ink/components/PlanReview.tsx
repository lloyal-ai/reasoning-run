/**
 * PlanReview — center dialog shown after the planner returns a research
 * plan and before research starts.
 *
 * Always-editable list (no editor "mode" toggle). One keymap, no overlap
 * on Enter:
 *
 *   ↑↓        select task
 *   ⏎         edit focused task (opens inline TextInput)
 *   A or +    add empty task after focused
 *   D or Del  delete focused (no-op if only 1 task)
 *   ⇧↑ ⇧↓    move focused up/down
 *   S         start research (the only way; Enter never triggers it)
 *   T         toggle reasoning mode (Deep/Fast — re-plans, discards edits)
 *   Esc       cancel plan
 *
 * In single-task edit (focused row replaced by TextInput):
 *   ⏎         save  ·  Esc  revert
 *
 * Why no modes: the previous design gated CRUD behind an explicit
 * "editor mode" (E to enter, Esc to exit) so Enter could mean "Start
 * research" by default. Users hit Enter expecting "edit focused task"
 * and got research started instead. Removing the mode means Enter has
 * one stable meaning ("edit focused thing") and S has the other
 * ("start"). Distinct keys, no overlap.
 *
 * Why a stateRef workaround: Ink 7's useInput uses React 19's
 * useEffectEvent under the hood. In practice (React 19.2.5 + Ink
 * 7.0.1), the handler closure goes stale — keys read state from the
 * first render forever. The stateRef pattern below mirrors local
 * state into a ref synchronously each render, so the handler always
 * sees fresh values regardless of closure capture.
 *
 * Clarify intent and passthrough intent reuse the surrounding shell
 * but show different bodies — Enter on clarify routes back to the
 * composer with the original query prefilled (existing behavior).
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState } from '../state';
import { useCommand } from '../hooks/useCommand';
import { TextInput } from './TextInput';

export interface PlanReviewProps {
  state: AppState;
}

export const PlanReview = memo(function PlanReview({ state }: PlanReviewProps): React.ReactElement | null {
  const dispatch = useCommand();
  const plan = state.plan;
  const [mode, setMode] = useState<'flat' | 'deep'>(state.mode ?? 'deep');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  // Reset focus + draft when the planner replaces the task list (T
  // toggle re-plans). Local mutations (add/delete/move) leave focus
  // alone — handled by the next effect.
  useEffect(() => {
    if (state.mode && state.mode !== mode) setMode(state.mode);
    setEditingIndex(null);
    setFocusedIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode]);

  // Clamp focus when tasks shrink (delete on last task).
  useEffect(() => {
    if (!plan) return;
    if (focusedIndex >= plan.tasks.length) {
      setFocusedIndex(Math.max(0, plan.tasks.length - 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.tasks.length]);

  // Mirror state into a ref each render so the input handler — whose
  // closure goes stale (Ink 7 + React 19 useEffectEvent issue) — can
  // read fresh values. See module docstring.
  const stateRef = useRef({
    focusedIndex,
    editingIndex,
    mode,
    plan,
    query: state.query,
  });
  stateRef.current = {
    focusedIndex,
    editingIndex,
    mode,
    plan,
    query: state.query,
  };

  useInput((input, key) => {
    const s = stateRef.current;
    const plan = s.plan;
    const editingIndex = s.editingIndex;
    const focusedIndex = s.focusedIndex;
    const mode = s.mode;

    if (!plan) return;

    // ── Single-task edit mode delegates to TextInput ──────────────
    if (editingIndex !== null) return;

    // ── Clarify / passthrough: keymap unchanged ───────────────────
    if (plan.intent !== 'research') {
      if (key.return) {
        if (plan.intent === 'clarify') {
          dispatch({ type: 'edit_plan', query: s.query });
        }
        return;
      }
      if (key.escape) dispatch({ type: 'cancel_plan' });
      if (key.ctrl && input === 'c') dispatch({ type: 'quit' });
      return;
    }

    // ── Research-plan keymap (no modes) ───────────────────────────
    if (key.ctrl && input === 'c') {
      dispatch({ type: 'quit' });
      return;
    }
    if (key.escape) {
      dispatch({ type: 'cancel_plan' });
      return;
    }

    // S starts research. Distinct from Enter (which edits) so Enter
    // can't accidentally start research the user didn't mean to.
    if (input === 's' || input === 'S') {
      dispatch({ type: 'accept_plan' });
      return;
    }

    // Reorder (Shift + arrows) before plain arrows.
    if (key.shift && key.upArrow) {
      if (focusedIndex > 0) {
        dispatch({ type: 'move_task', from: focusedIndex, to: focusedIndex - 1 });
        setFocusedIndex(focusedIndex - 1);
      }
      return;
    }
    if (key.shift && key.downArrow) {
      if (focusedIndex < plan.tasks.length - 1) {
        dispatch({ type: 'move_task', from: focusedIndex, to: focusedIndex + 1 });
        setFocusedIndex(focusedIndex + 1);
      }
      return;
    }
    if (key.upArrow) {
      setFocusedIndex(Math.max(0, focusedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedIndex(Math.min(plan.tasks.length - 1, focusedIndex + 1));
      return;
    }

    if (key.return) {
      // Always: edit the focused task. (Start research is on S.)
      setDraft(plan.tasks[focusedIndex]?.description ?? '');
      setEditingIndex(focusedIndex);
      return;
    }

    if (input === 'a' || input === 'A' || input === '+') {
      const newIndex = focusedIndex + 1;
      dispatch({ type: 'add_task', afterIndex: focusedIndex });
      setFocusedIndex(newIndex);
      setDraft('');
      setEditingIndex(newIndex);
      return;
    }

    if (input === 'd' || input === 'D' || key.delete) {
      if (plan.tasks.length > 1) {
        dispatch({ type: 'delete_task', index: focusedIndex });
      }
      return;
    }

    if (input === 't' || input === 'T') {
      const next = mode === 'deep' ? 'flat' : 'deep';
      setMode(next);
      dispatch({ type: 'change_mode', mode: next });
      return;
    }
  });

  if (!plan) return null;

  // ── Clarify intent: planner asked questions ─────────────────────
  if (plan.intent === 'clarify') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text bold>{state.query}</Text>
        </Box>
        <Text dimColor>A few questions to narrow this down.</Text>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginTop={1}
        >
          {plan.clarifyQuestions.map((q, i) => (
            <Text key={i}>
              <Text dimColor>({i + 1})</Text> {q}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>⏎ answer · Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── Passthrough intent: planner answered directly ──────────────
  if (plan.intent === 'passthrough') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{state.query}</Text>
        <Text dimColor>Answering directly — no research needed.</Text>
      </Box>
    );
  }

  // ── Research intent: editable list ─────────────────────────────
  const shape = mode === 'flat' ? 'parallel' : 'chained';
  const editing = editingIndex !== null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold>{state.query}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Research plan</Text>
        <Text dimColor> · {plan.tasks.length} {shape} tasks</Text>
        {editing ? (
          <Text color="yellow"> · editing row {editingIndex! + 1}</Text>
        ) : null}
      </Box>

      <Box flexDirection="column">
        {plan.tasks.map((t, i) => (
          <PlanRow
            key={i}
            index={i}
            description={t.description}
            focused={i === focusedIndex}
            editing={i === editingIndex}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={(value) => {
              dispatch({
                type: 'update_task_description',
                index: i,
                description: value.trim(),
              });
              setEditingIndex(null);
            }}
            onCancel={() => setEditingIndex(null)}
          />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={mode === 'deep' ? 'cyan' : undefined} bold={mode === 'deep'}>
          {mode === 'deep' ? '◆' : '○'} Deep
        </Text>
        <Text>  </Text>
        <Text color={mode === 'flat' ? 'cyan' : undefined} bold={mode === 'flat'}>
          {mode === 'flat' ? '◆' : '○'} Fast
        </Text>
        <Text dimColor>     T toggle mode (re-plans, discards edits)</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {editing ? (
          <Text dimColor>⏎ save · Esc revert</Text>
        ) : (
          <>
            <Box>
              <Text dimColor>↑↓ select · </Text>
              <Text color="cyan" bold>⏎ edit</Text>
              <Text dimColor> · A add · D delete · ⇧↑↓ reorder · Esc cancel</Text>
            </Box>
            <Box>
              <Text color="green" bold>S</Text>
              <Text> </Text>
              <Text color="green" bold>start research →</Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
});

interface PlanRowProps {
  index: number;
  description: string;
  focused: boolean;
  editing: boolean;
  draft: string;
  onDraftChange: (next: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

const PlanRow = memo(function PlanRow({
  index,
  description,
  focused,
  editing,
  draft,
  onDraftChange,
  onSubmit,
  onCancel,
}: PlanRowProps): React.ReactElement {
  if (editing) {
    return (
      <Box paddingLeft={2}>
        <Text color="yellow" bold>{`▶ ${index + 1}. `}</Text>
        <Box flexGrow={1}>
          <TextInput
            value={draft}
            onChange={onDraftChange}
            onSubmit={onSubmit}
            onCancel={onCancel}
            focused
            placeholder="(empty — type a task description)"
          />
        </Box>
      </Box>
    );
  }
  if (focused) {
    return (
      <Box paddingLeft={2}>
        <Text color="cyan" bold>{`› ${index + 1}. `}</Text>
        <Text bold>{description || <Text dimColor>(empty)</Text>}</Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text dimColor>{`  ${index + 1}. `}</Text>
      <Text dimColor>{description || '(empty)'}</Text>
    </Box>
  );
});
