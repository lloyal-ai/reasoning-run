/**
 * Composer — Gemini-style bottom-docked query input + source chips +
 * PLAN/START submit selector. Slash commands invoke modal actions
 * inline (type `/` to begin).
 *
 * Slash command grammar:
 *   /cmd               → open the inline editor for `cmd` (pre-filled with
 *                        current value); user submits to commit.
 *   /cmd <value>       → set `cmd` to `value` directly, no editor step.
 *   /deep | /flat      → set reasoning mode immediately (power-user
 *                        shortcut; primary toggle lives in PlanReview).
 *   /quit              → exit the program.
 *   /help              → show this list.
 *
 * Reasoning mode (Deep/Flat) is intentionally absent from the visible
 * composer — it's chosen on the PlanReview screen via T-toggle, where
 * the user can see what the planner produced before committing to a
 * shape. The composer focuses on "what" (query, sources, submit
 * intent); plan-review handles "how".
 *
 * Keybindings on the query field:
 *   Enter      → submit using the focused button (PLAN runs the planner;
 *                START synthesizes a single-task plan and runs research).
 *   Shift+Tab  → toggle PLAN ↔ START.
 *   Tab        → autocomplete the current slash command (no-op outside
 *                slash mode).
 *   Esc        → in clarifying mode: cancel pending plan. Otherwise: clear
 *                input.
 *   Ctrl-C     → quit.
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState, UiPhase } from '../state';
import { useCommand } from '../hooks/useCommand';
import { TextInput } from './TextInput';
import { shortPath } from '../path-utils';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';

type Field = 'query' | 'web' | 'scan' | 'output' | 'model' | 'reranker';

type SlashCmdKind = 'instant' | 'value';

interface SlashCmd {
  name: string;
  desc: string;
  kind: SlashCmdKind;
}

/** Single source of truth for slash-command discovery, completion, and
 *  help rendering. Order is the order shown to the user. */
const COMMANDS: SlashCmd[] = [
  { name: 'scan', desc: 'Set local file source (path or glob)', kind: 'value' },
  { name: 'web', desc: 'Set web search key', kind: 'value' },
  { name: 'model', desc: 'Set local LLM .gguf path', kind: 'value' },
  { name: 'reranker', desc: 'Set local reranker .gguf path', kind: 'value' },
  { name: 'gpu', desc: 'Set GPU backend (cuda|vulkan|default)', kind: 'value' },
  { name: 'output', desc: 'Set output directory', kind: 'value' },
  { name: 'deep', desc: 'Use deep (chain) reasoning', kind: 'instant' },
  { name: 'flat', desc: 'Use flat (parallel) reasoning', kind: 'instant' },
  { name: 'help', desc: 'Show this list', kind: 'instant' },
  { name: 'quit', desc: 'Quit', kind: 'instant' },
];

interface ParsedSlash {
  name: string;
  value: string;
}

function parseSlash(input: string): ParsedSlash | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trimStart();
  if (!trimmed) return { name: '', value: '' }; // bare "/"
  const sp = trimmed.search(/\s/);
  const name = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const value = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  return { name, value };
}

/** Filter COMMANDS by the parsed slash prefix. Returns the command list
 *  the palette should display while the user is typing. */
function filterCommands(parsed: ParsedSlash | null): SlashCmd[] {
  if (!parsed) return [];
  if (!parsed.name) return COMMANDS;
  const prefix = parsed.name.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export interface ComposerProps {
  state: AppState;
}

export const Composer = memo(function Composer({ state }: ComposerProps): React.ReactElement {
  const dispatch = useCommand();
  const defaultMode = state.config?.defaults.reasoningMode ?? 'flat';
  const [mode, setMode] = useState<'flat' | 'deep'>(defaultMode);
  const [field, setField] = useState<Field>('query');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  // Submit mode toggled by Shift+Tab. PLAN runs the planner and shows
  // the plan-review dialog; START synthesizes a single-task plan from
  // the literal query and skips plan-review. Default flips after the
  // first completed report: cold start → PLAN (the planner shapes a
  // research plan from a fresh query); warm follow-up → START (after
  // a report, most queries are conversational follow-ups that don't
  // need re-planning).
  //
  // Signal: scrollback length. The reducer pushes synth/agent items
  // into scrollback once research+synth complete, so >0 reliably
  // means "at least one report has finished". We avoid `state.warm`
  // here because it only refreshes on the NEXT `query` event (it's
  // sourced from `!!session.trunk` at that moment), so it's stale
  // during the window between report completion and follow-up
  // submission — exactly the window where the user sees the
  // composer.
  const hasReport = state.scrollback.length > 0;
  const [submitMode, setSubmitMode] = useState<'plan' | 'start'>(
    hasReport ? 'start' : 'plan',
  );
  /** Chip focus for Tab-cycle. `null` means the query text field is
   *  focused (default). Each chip name corresponds to a source app
   *  (`'web'`, `'corpus'`) or a setting (`'output'`). When non-null,
   *  Space toggles participation on a source chip (or opens config if
   *  unconfigured); Enter opens the inline config editor; Esc returns
   *  focus to the query text field. */
  const [chipFocus, setChipFocus] = useState<'web' | 'corpus' | 'output' | null>(null);
  // Ref-mirror of chipFocus + config-derived inputs so the chip useInput
  // handler reads fresh values. Ink 7's useInput closure goes stale under
  // React 19's useEffectEvent (same workaround as PlanReview.tsx).
  const chipStateRef = useRef<{
    chipFocus: typeof chipFocus;
    tavilyKey: string;
    corpusPath: string;
    outputDir: string;
    envLocked: boolean;
  }>({
    chipFocus,
    tavilyKey: String(state.config?.apps.web?.tavilyKey ?? ''),
    corpusPath: String(state.config?.apps.corpus?.corpusPath ?? ''),
    outputDir: state.config?.sources.outputDir ?? '',
    envLocked: false,
  });

  // When the first report's content lands in scrollback, flip the
  // default. Subsequent user toggles via Shift+Tab override this.
  useEffect(() => {
    if (hasReport) setSubmitMode('start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReport]);

  // Apply a prefill from "edit plan" when the composer regains focus.
  useEffect(() => {
    if (state.composerPrefill && state.composerPrefill !== query) {
      setQuery(state.composerPrefill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.composerPrefill]);

  // Keep mode in sync if config default changes externally.
  useEffect(() => {
    setMode(defaultMode);
  }, [defaultMode]);

  const storedTavily = String(state.config?.apps.web?.tavilyKey ?? '');
  const storedCorpus = String(state.config?.apps.corpus?.corpusPath ?? '');
  const outputOrigin = state.configOrigin?.outputDir ?? 'default';
  const hasTavily = storedTavily !== '';
  // Web is always available — the web app falls back to a keyless provider when
  // no Tavily key is set — so there is always at least one research source.
  const hasSource = true;
  // Env-provided TAVILY_API_KEY is consumed inside the web app factory; the
  // harness config layer no longer tracks its origin, so the composer doesn't
  // lock the field on env any more (the Settings drawer is the richer surface).
  const envLocked = false;

  // Re-mirror chip state into the ref every render so the chip useInput
  // handler always sees fresh values (closure stale-read workaround).
  chipStateRef.current = {
    chipFocus,
    tavilyKey: storedTavily,
    corpusPath: storedCorpus,
    outputDir: state.config?.sources.outputDir ?? '',
    envLocked,
  };

  const clarifying = state.clarifyContext !== null;
  const parsedSlash = parseSlash(query);
  const inSlash = parsedSlash !== null;
  const matches = filterCommands(parsedSlash);

  // ── Run mode ──────────────────────────────────────────────────
  // While a run is active the composer stays mounted but morphs: the input
  // row becomes a status line, the PLAN/START pill becomes WRAP UP / STOP,
  // and a run keymap takes over (the query/chip handlers deactivate).
  const running =
    state.uiPhase === 'discovering' ||
    state.uiPhase === 'planning' ||
    state.uiPhase === 'research';
  const inResearch = state.uiPhase === 'research';
  // Which run pill Enter fires. Esc jumps focus here to STOP — the "armed"
  // state for the destructive action is visible focus, not a hidden timer.
  const [runFocus, setRunFocus] = useState<'wrap_up' | 'stop'>('wrap_up');
  // Set locally when wrap_up is dispatched. There is deliberately no
  // reducer-level wind-down state: the engine drains via the WindDown
  // signal and the reducer only sees agents flipping to `recovering`.
  const [windingDown, setWindingDown] = useState(false);
  useEffect(() => {
    if (!running) {
      setRunFocus('wrap_up');
      setWindingDown(false);
    }
  }, [running]);

  // Ref-mirror for the run keymap (same stale-closure workaround as the
  // chip handler below / PlanReview.tsx).
  const runStateRef = useRef({
    inResearch,
    runFocus,
    windingDown,
    mode: state.mode,
    agents: state.agents,
    researchAgentIds: state.researchAgentIds,
  });
  runStateRef.current = {
    inResearch,
    runFocus,
    windingDown,
    mode: state.mode,
    agents: state.agents,
    researchAgentIds: state.researchAgentIds,
  };

  useInput(
    (input, key) => {
      const s = runStateRef.current;
      if (key.ctrl && input === 'c') {
        dispatch({ type: 'quit' });
        return;
      }
      if (key.escape) {
        // Outside research there is no wrap/stop choice (desktop mirror:
        // the popover only exists in research) — Esc stops directly.
        if (!s.inResearch || s.runFocus === 'stop') {
          dispatch({ type: 'stop' });
          return;
        }
        setRunFocus('stop');
        return;
      }
      if (key.return) {
        if (s.inResearch && s.runFocus === 'wrap_up') {
          // Repeat sends are harmless — windDown is a signal, not a toggle.
          dispatch({ type: 'wrap_up' });
          setWindingDown(true);
          return;
        }
        dispatch({ type: 'stop' });
        return;
      }
      if (key.tab) {
        if (s.inResearch) {
          setRunFocus((f) => (f === 'wrap_up' ? 'stop' : 'wrap_up'));
        }
        return;
      }
      if (input === 'w' && s.inResearch) {
        dispatch({ type: 'wrap_up' });
        setWindingDown(true);
        return;
      }
      // Digits cancel one live flat-mode agent by its card badge — the
      // digit is taskIndex + 1 (stable across the run; researchAgentIds
      // reindexes as agents finish, task numbers don't). Offer-condition
      // mirrors the desktop card (cards.tsx): not terminal, not
      // recovering, flat mode, and >1 agent live (never cancel into an
      // empty synth). Ineligible presses fail silently — ui:error is NOT
      // usable here (its reducer case force-returns to the composer
      // phase).
      if (s.inResearch && input >= '1' && input <= '9') {
        if (s.mode !== 'flat' || s.researchAgentIds.length <= 1) return;
        const digit = Number(input);
        const id = s.researchAgentIds.find(
          (aid) => s.agents.get(aid)?.taskIndex === digit - 1,
        );
        if (id === undefined) return;
        const agent = s.agents.get(id);
        if (!agent || agent.phase === 'done' || agent.phase === 'failed' || agent.recovering) {
          return;
        }
        dispatch({ type: 'cancel_agent', agentId: id });
        return;
      }
    },
    { isActive: running },
  );

  // Query field input handling: Tab + Esc + Ctrl-C. TextInput owns
  // character entry. Tab autocompletes the slash command when in slash
  // mode; otherwise toggles reasoning mode (existing behavior).
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        dispatch({ type: 'quit' });
        return;
      }
      if (key.tab && key.shift) {
        // Shift+Tab toggles submit target between PLAN and START.
        if (!inSlash && !clarifying) {
          setSubmitMode((m) => (m === 'plan' ? 'start' : 'plan'));
        }
        return;
      }
      if (key.tab) {
        if (inSlash && parsedSlash && parsedSlash.name && matches.length === 1) {
          const cmd = matches[0];
          // Complete with trailing space for value commands so the user
          // can type the value next; instant commands stay as-is.
          setQuery('/' + cmd.name + (cmd.kind === 'value' ? ' ' : ''));
          return;
        }
        // Tab outside slash mode advances chip focus. Cycle order:
        //   query → web → scan → output → query
        // Allows the user to Tab to a source chip and Space-toggle its
        // participation without leaving the keyboard.
        if (!inSlash && !clarifying) {
          setChipFocus('web');
        }
        return;
      }
      // Down-arrow drops focus from the query field into the chip row.
      // Familiar from form UIs: query is the "top row," chips sit below.
      if (key.downArrow && !inSlash && !clarifying) {
        setChipFocus('web');
        return;
      }
      if (key.escape) {
        if (clarifying) {
          dispatch({ type: 'cancel_plan' });
          setQuery('');
          return;
        }
        // Clear current input. No menu mode anymore.
        setQuery('');
        setShowHelp(false);
        return;
      }
    },
    { isActive: field === 'query' && chipFocus === null && !running },
  );

  // Chip-focus input handling: active when a source/setting chip is the
  // current Tab target. Tab cycles to the next chip (or back to query).
  // Space toggles participation on a source chip (or opens config if
  // unconfigured). Enter opens the inline config editor. Esc returns
  // focus to the query field.
  useInput(
    (input, key) => {
      // Read all state through the ref — Ink 7's useInput closure goes
      // stale otherwise (same pattern as PlanReview).
      const s = chipStateRef.current;
      if (key.ctrl && input === 'c') {
        dispatch({ type: 'quit' });
        return;
      }
      if (key.escape) {
        setChipFocus(null);
        return;
      }
      // Up-arrow returns focus to the query field. Mirrors the down-arrow
      // entry shortcut from the query-focused branch above.
      if (key.upArrow) {
        setChipFocus(null);
        return;
      }
      // Tab and right-arrow cycle forward through the chips. The cycle
      // wraps back to the query field after the last chip — same as
      // Tab from the last chip. Shift+Tab and left-arrow go backward.
      const chipOrder: ('web' | 'corpus' | 'output')[] = ['web', 'corpus', 'output'];
      if (key.tab || key.rightArrow) {
        if (key.shift) {
          const idx = chipOrder.indexOf(s.chipFocus as 'web' | 'corpus' | 'output');
          setChipFocus(idx === 0 ? null : chipOrder[idx - 1]);
          return;
        }
        const idx = chipOrder.indexOf(s.chipFocus as 'web' | 'corpus' | 'output');
        setChipFocus(idx === chipOrder.length - 1 ? null : chipOrder[idx + 1]);
        return;
      }
      if (key.leftArrow) {
        const idx = chipOrder.indexOf(s.chipFocus as 'web' | 'corpus' | 'output');
        setChipFocus(idx <= 0 ? null : chipOrder[idx - 1]);
        return;
      }
      if (s.chipFocus === 'web') {
        if (input === ' ') {
          dispatch({ type: 'toggle_participation', name: 'web' });
          // Auto-advance focus so multi-toggle is quick.
          setChipFocus('corpus');
          return;
        }
        if (key.return) {
          if (s.envLocked) return;
          setDraft(s.tavilyKey);
          setField('web');
          setChipFocus(null);
          return;
        }
      } else if (s.chipFocus === 'corpus') {
        const corpusConfigured = !!s.corpusPath;
        if (input === ' ') {
          if (!corpusConfigured) {
            // Unconfigured → Space opens config (no participation to flip).
            setDraft('');
            setField('scan');
            setChipFocus(null);
            return;
          }
          dispatch({ type: 'toggle_participation', name: 'corpus' });
          setChipFocus('output');
          return;
        }
        if (key.return) {
          setDraft(s.corpusPath);
          setField('scan');
          setChipFocus(null);
          return;
        }
      } else if (s.chipFocus === 'output') {
        if (input === ' ' || key.return) {
          setDraft(s.outputDir);
          setField('output');
          setChipFocus(null);
          return;
        }
      }
    },
    { isActive: chipFocus !== null && field === 'query' && !running },
  );

  const submitQuery = (q: string): void => {
    const trimmed = q.trim();
    if (!trimmed) return;

    // Slash command path (skipped in clarifying mode — the user is
    // answering a planner question, not running commands).
    if (!clarifying) {
      const slash = parseSlash(trimmed);
      if (slash) {
        handleSlash(slash);
        return;
      }
    }

    if (clarifying) {
      dispatch({ type: 'submit_clarification', answer: trimmed });
      setQuery('');
      return;
    }
    if (!hasSource) return;
    dispatch({
      type: 'submit_query',
      query: trimmed,
      mode,
      skipPlanner: submitMode === 'start',
    });
    setQuery('');
  };

  const handleSlash = ({ name, value }: ParsedSlash): void => {
    if (!name) return;                             // bare "/", no-op
    const cmd = COMMANDS.find((c) => c.name === name);
    if (!cmd) {
      // Unknown command — leave the input as-is so the user sees their
      // typo. Help line below already shows valid commands.
      return;
    }
    setQuery('');
    setShowHelp(false);
    if (cmd.kind === 'instant') {
      if (name === 'deep') setMode('deep');
      else if (name === 'flat') setMode('flat');
      else if (name === 'quit') dispatch({ type: 'quit' });
      else if (name === 'help') setShowHelp(true);
      return;
    }
    // value command. The /web and /scan slashes map to per-app config via
    // the generic set_app_config command (name = the app's manifest.name,
    // values = its whole config object).
    if (value) {
      if (name === 'web') dispatch({ type: 'set_app_config', name: 'web', values: { tavilyKey: value } });
      else if (name === 'scan') dispatch({ type: 'set_app_config', name: 'corpus', values: { corpusPath: value } });
      else if (name === 'output') dispatch({ type: 'set_output_dir', path: value });
      else if (name === 'model') dispatch({ type: 'set_model_path', path: value });
      else if (name === 'reranker') dispatch({ type: 'set_reranker_path', path: value });
      else if (name === 'gpu') {
        // Closed value set — an unknown backend falls through to the help
        // list (whose /gpu row names the valid values) instead of persisting.
        if (value === 'cuda' || value === 'vulkan' || value === 'default') {
          dispatch({ type: 'set_gpu', gpu: value });
        } else {
          setShowHelp(true);
        }
      }
      return;
    }
    // No value — open the inline editor pre-filled with the current value.
    if (name === 'web') {
      if (envLocked) return;
      setDraft(String(state.config?.apps.web?.tavilyKey ?? ''));
      setField('web');
    } else if (name === 'scan') {
      setDraft(String(state.config?.apps.corpus?.corpusPath ?? ''));
      setField('scan');
    } else if (name === 'output') {
      setDraft(state.config?.sources.outputDir ?? '');
      setField('output');
    } else if (name === 'model') {
      setDraft(state.config?.model.path ?? '');
      setField('model');
    } else if (name === 'reranker') {
      setDraft(state.config?.model.reranker ?? '');
      setField('reranker');
    } else if (name === 'gpu') {
      // No inline editor for the closed value set — surface the help list,
      // whose /gpu row names the valid values.
      setShowHelp(true);
    }
  };

  const commitWeb = (): void => {
    const key = draft.trim();
    // Empty input clears the key (whole-replace with {}) → keyless fallback.
    dispatch({
      type: 'set_app_config',
      name: 'web',
      values: key ? { tavilyKey: key } : {},
    });
    setField('query');
    setDraft('');
  };

  const commitScan = (): void => {
    const p = draft.trim();
    dispatch({
      type: 'set_app_config',
      name: 'corpus',
      values: p ? { corpusPath: p } : {},
    });
    setField('query');
    setDraft('');
  };

  const commitOutput = (): void => {
    dispatch({ type: 'set_output_dir', path: draft.trim() });
    setField('query');
    setDraft('');
  };

  const commitModel = (): void => {
    dispatch({ type: 'set_model_path', path: draft.trim() });
    setField('query');
    setDraft('');
  };

  const commitReranker = (): void => {
    dispatch({ type: 'set_reranker_path', path: draft.trim() });
    setField('query');
    setDraft('');
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {/* Main row: run status line, query input, or inline editor */}
      {running ? (
        <RunStatusLine
          uiPhase={state.uiPhase}
          liveCount={state.researchAgentIds.length}
          windingDown={windingDown}
        />
      ) : field === 'query' ? (
        <Box>
          <Text>› </Text>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={submitQuery}
            focused={chipFocus === null}
            placeholder={
              clarifying
                ? 'Answer the questions above, or Esc to cancel…'
                : hasSource
                  ? 'Ask a research question, or / for commands…'
                  : 'Type / for commands (e.g. /web, /scan) to add a source'
            }
          />
        </Box>
      ) : field === 'web' ? (
        <Box>
          <Text color="yellow">Web search key › </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitWeb}
            onCancel={() => { setField('query'); setDraft(''); }}
            focused
            mask
            placeholder="tvly-..."
          />
        </Box>
      ) : field === 'scan' ? (
        <Box>
          <Text color="yellow">Scan path › </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitScan}
            onCancel={() => { setField('query'); setDraft(''); }}
            focused
            placeholder="/path/to/docs or /path/**/*.md"
          />
        </Box>
      ) : field === 'output' ? (
        <Box>
          <Text color="yellow">Output dir › </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitOutput}
            onCancel={() => { setField('query'); setDraft(''); }}
            focused
            placeholder={`${process.cwd()} (default)`}
          />
        </Box>
      ) : field === 'model' ? (
        <Box>
          <Text color="yellow">Model path › </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitModel}
            onCancel={() => { setField('query'); setDraft(''); }}
            focused
            placeholder="/path/to/qwen3.5-4b.gguf"
          />
        </Box>
      ) : (
        <Box>
          <Text color="yellow">Reranker path › </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitReranker}
            onCancel={() => { setField('query'); setDraft(''); }}
            focused
            placeholder="/path/to/qwen3-reranker.gguf"
          />
        </Box>
      )}

      {/* Slash command palette — shown live while the user types `/`.
        Filters by prefix. Disabled in clarifying mode (the user is
        answering a planner question, not running commands). */}
      {field === 'query' && !clarifying && inSlash ? (
        <Box flexDirection="column" marginTop={0}>
          {matches.length === 0 ? (
            <Text color="red">no matching command</Text>
          ) : (
            matches.map((c) => (
              <SlashCmdRow key={c.name} cmd={c} />
            ))
          )}
        </Box>
      ) : null}

      {/* Persistent help — toggled via /help. */}
      {field === 'query' && !inSlash && showHelp ? (
        <Box flexDirection="column" marginTop={0}>
          {COMMANDS.map((c) => <SlashCmdRow key={c.name} cmd={c} />)}
        </Box>
      ) : null}

      {/* Chips row — sources + the primary PLAN/START buttons.
          Reasoning mode (Deep/Flat) is chosen on the PlanReview screen
          (T toggles), not here — keeping the composer focused on
          "what" and deferring "how" to plan-review.

          Source chips carry a tri-state participation glyph (●/○/─) and
          are Tab-focusable for keyboard toggle/configure. Output is a
          setting chip — no participation, no Space toggle (Enter still
          opens its config when focused). */}
      <Box marginTop={0}>
        <SourceChip
          label="Web"
          origin={hasTavily ? 'file' : 'unset'}
          value={hasTavily ? '(Tavily)' : '(Keyless)'}
          alwaysActive
          disabled={envLocked}
          participation={
            state.participation['web'] !== false ? 'included' : 'excluded'
          }
          focused={chipFocus === 'web'}
        />
        <Text>  </Text>
        <SourceChip
          label="Scan"
          origin={storedCorpus ? 'file' : 'unset'}
          value={
            storedCorpus
              ? state.corpusStatus
                ? `${state.corpusStatus.fileCount} files`
                : storedCorpus
              : null
          }
          participation={
            !storedCorpus
              ? 'unconfigured'
              : state.participation['corpus'] !== false
                ? 'included'
                : 'excluded'
          }
          focused={chipFocus === 'corpus'}
        />
        <Text dimColor>  │  </Text>
        <SourceChip
          label="Output dir"
          origin={outputOrigin}
          // Effective destination — mirrors main.ts's `outputDir ?? cwd`
          // fallback. Shows the user where runs actually land, not just
          // what's configured.
          value={shortPath(state.config?.sources.outputDir || process.cwd())}
          focused={chipFocus === 'output'}
        />
        <Box flexGrow={1} />
        {running ? (
          <RunButtons
            inResearch={inResearch}
            runFocus={runFocus}
            windingDown={windingDown}
          />
        ) : field === 'query' && !clarifying && !inSlash && chipFocus === null ? (
          <SubmitButtons submitMode={submitMode} />
        ) : null}
      </Box>
      <Box marginTop={0}>
        {running ? (
          <RunHintRow
            inResearch={inResearch}
            runFocus={runFocus}
            windingDown={windingDown}
            cancelDigits={
              state.mode === 'flat' && state.researchAgentIds.length > 1
                ? state.researchAgentIds
                    .map((id) => state.agents.get(id)?.taskIndex)
                    .filter((t): t is number => t != null)
                    .map((t) => t + 1)
                : []
            }
          />
        ) : (
          <HintRow
            field={field}
            hasSource={hasSource}
            inSlash={inSlash}
            clarifying={clarifying}
            chipFocus={chipFocus}
          />
        )}
      </Box>

      {/* Toast (transient) */}
      {state.toast ? (
        <Box marginTop={0}>
          <Text
            color={
              state.toast.tone === 'error'
                ? 'red'
                : state.toast.tone === 'warn'
                  ? 'yellow'
                  : 'green'
            }
          >
            {state.toast.message}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

const SlashCmdRow = memo(function SlashCmdRow({ cmd }: { cmd: SlashCmd }): React.ReactElement {
  return (
    <Box>
      <Text color="cyan">/{cmd.name}</Text>
      <Text dimColor>{' · '}{cmd.desc}</Text>
      {cmd.kind === 'value' ? <Text dimColor>{' <value>'}</Text> : null}
    </Box>
  );
});

const SourceChip = memo(function SourceChip({
  label,
  origin,
  value,
  disabled = false,
  alwaysActive = false,
  participation,
  focused = false,
}: {
  label: string;
  origin: string;
  value: string | null;
  disabled?: boolean;
  /** Chip is active regardless of config origin (e.g. Web has a keyless
   *  fallback, so it is always a live source). */
  alwaysActive?: boolean;
  /** Tri-state per-query participation: `'included'` = participating in
   *  the next query (filled glyph `●`); `'excluded'` = configured but
   *  parked (hollow glyph `○`); `'unconfigured'` = no config (dash glyph
   *  `─`). When omitted the chip is a settings-only indicator (e.g.
   *  Output) and gets no participation glyph. */
  participation?: 'included' | 'excluded' | 'unconfigured';
  /** When true, the chip is the current Tab-focus target: Space toggles
   *  participation, Enter opens the inline config editor. Rendered with
   *  inverse video to make the focus visible. */
  focused?: boolean;
}): React.ReactElement {
  const configured = alwaysActive || origin !== 'unset';
  const tag =
    origin === 'env' ? ' (env)'
      : origin === 'cli' ? ' (cli)'
      : '';
  const suffix = !configured ? '—' : (value ?? '✓');
  const glyph =
    participation === 'included' ? '● '
      : participation === 'excluded' ? '○ '
      : participation === 'unconfigured' ? '─ '
      : '';
  // Color encodes participation state on top of configured: included ⇒
  // green (live), excluded ⇒ yellow (parked but configured), unconfigured
  // / no participation ⇒ gray.
  const color =
    participation === 'excluded' ? 'yellow'
      : !configured ? 'gray'
      : 'green';
  const body = `${glyph}${label} ${suffix}`;
  if (focused) {
    return (
      <Text>
        <Text backgroundColor="cyan" color="black" bold>
          {` ${body} `}
        </Text>
        <Text dimColor>{tag}</Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color={color} dimColor={disabled}>
        {body}
      </Text>
      <Text dimColor>{tag}</Text>
    </Text>
  );
});

const HintRow = memo(function HintRow({
  field,
  hasSource,
  inSlash,
  clarifying,
  chipFocus,
}: {
  field: Field;
  hasSource: boolean;
  inSlash: boolean;
  clarifying: boolean;
  chipFocus: 'web' | 'corpus' | 'output' | null;
}): React.ReactElement {
  if (field === 'web' || field === 'scan' || field === 'output' || field === 'model' || field === 'reranker') {
    return <Text dimColor>⏎ save (empty to clear) · Ctrl+U clear · Esc cancel</Text>;
  }
  if (clarifying) {
    return <Text color="yellow">⏎ submit answer · Esc cancel</Text>;
  }
  if (inSlash) {
    return <Text dimColor>Tab complete · ⏎ run · Esc clear</Text>;
  }
  if (chipFocus !== null) {
    // Source chip focused — Space toggles participation; Enter opens
    // the chip's inline config editor; Tab cycles to the next chip.
    return <Text dimColor>Space toggle · ⏎ configure · Tab next · Esc back</Text>;
  }
  if (!hasSource) {
    return <Text color="yellow">⚠ Add a source via /web or /scan</Text>;
  }
  // ⏎ submit is implied by the highlighted button. Just the
  // PLAN/START toggle and slash/chip pointer here.
  return <Text dimColor>⇧Tab Plan/Start · Tab focus chips · / commands</Text>;
});

const SubmitButtons = memo(function SubmitButtons({
  submitMode,
}: {
  submitMode: 'plan' | 'start';
}): React.ReactElement {
  // Primary action buttons. Reasoning mode (Deep/Flat) lives on the
  // PlanReview screen, not here.
  return (
    <Box>
      <SubmitButton label="PLAN" focused={submitMode === 'plan'} hue="cyan" />
      <Text>  </Text>
      <SubmitButton label="START" focused={submitMode === 'start'} hue="green" />
    </Box>
  );
});

const SubmitButton = memo(function SubmitButton({
  label,
  focused,
  hue,
}: {
  label: string;
  focused: boolean;
  hue: 'cyan' | 'green' | 'yellow' | 'red';
}): React.ReactElement {
  const glyph = focused ? '◉' : '○';
  const body = ` ${glyph} ${label} `;
  if (focused) {
    return (
      <Text backgroundColor={hue} color="black" bold>
        {body}
      </Text>
    );
  }
  return <Text dimColor>{body}</Text>;
});

// ── Run-mode dock pieces ─────────────────────────────────────────
// The composer stays mounted through the running phases; these morph its
// three rows. Same visual grammar as the idle dock: status where the
// input was, the pill group on the right, a dim hint line.

const RUN_PHASE_LABEL: Partial<Record<UiPhase, string>> = {
  discovering: 'Discovering',
  planning: 'Planning',
  research: 'Researching',
};

const RunStatusLine = memo(function RunStatusLine({
  uiPhase,
  liveCount,
  windingDown,
}: {
  uiPhase: UiPhase;
  liveCount: number;
  windingDown: boolean;
}): React.ReactElement {
  // Same inline-spinner pattern as ToolCallItem / PlanningSpinner.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, []);
  const label = windingDown
    ? 'Wrapping up'
    : (RUN_PHASE_LABEL[uiPhase] ?? 'Running');
  return (
    <Box>
      <Text color={windingDown ? 'yellow' : 'cyan'}>{SPINNER_FRAMES[frame]} </Text>
      <Text bold>{label}</Text>
      {uiPhase === 'research' && liveCount > 0 ? (
        <Text dimColor> · {liveCount} agent{liveCount === 1 ? '' : 's'} live</Text>
      ) : null}
    </Box>
  );
});

const RunButtons = memo(function RunButtons({
  inResearch,
  runFocus,
  windingDown,
}: {
  inResearch: boolean;
  runFocus: 'wrap_up' | 'stop';
  windingDown: boolean;
}): React.ReactElement {
  // Outside research there's no wrap/stop choice — STOP alone, always the
  // Enter/Esc target. WRAP UP keeps focus after firing (the pill flips to
  // a WINDING DOWN indicator) so a reflexive second Enter can't halt the
  // drain; reaching STOP stays deliberate (Esc / Shift+Tab).
  return (
    <Box>
      {inResearch ? (
        windingDown ? (
          <Text color="yellow"> ◐ WINDING DOWN </Text>
        ) : (
          <SubmitButton label="WRAP UP" focused={runFocus === 'wrap_up'} hue="yellow" />
        )
      ) : null}
      {inResearch ? <Text>  </Text> : null}
      <SubmitButton
        label="STOP"
        focused={!inResearch || runFocus === 'stop'}
        hue="red"
      />
    </Box>
  );
});

const RunHintRow = memo(function RunHintRow({
  inResearch,
  runFocus,
  windingDown,
  cancelDigits,
}: {
  inResearch: boolean;
  runFocus: 'wrap_up' | 'stop';
  windingDown: boolean;
  /** Badge digits of currently-cancellable agents ([] = don't offer). */
  cancelDigits: number[];
}): React.ReactElement {
  if (!inResearch) {
    return <Text dimColor>esc stop</Text>;
  }
  const digitHint =
    cancelDigits.length > 0
      ? ` · ${Math.min(...cancelDigits)}-${Math.max(...cancelDigits)} cancel agent`
      : '';
  if (windingDown) {
    return <Text dimColor>wrapping up…{digitHint} · esc stop</Text>;
  }
  if (runFocus === 'stop') {
    return (
      <Text dimColor>
        ⏎/esc stop <Text color="red">(discards run)</Text> · ⇧Tab wrap up instead
      </Text>
    );
  }
  return (
    <Text dimColor>⇧Tab wrap up/stop · ⏎ fire · w wrap up{digitHint}</Text>
  );
});

