/**
 * Composer — Gemini-style bottom-docked query input + mode toggle +
 * source chips. Slash commands replace the previous Esc-then-letter
 * menu: type `/` to invoke commands inline.
 *
 * Slash command grammar:
 *   /cmd               → open the inline editor for `cmd` (pre-filled with
 *                        current value); user submits to commit.
 *   /cmd <value>       → set `cmd` to `value` directly, no editor step.
 *   /deep | /fast      → set reasoning mode immediately.
 *   /quit              → exit the program.
 *   /help              → show this list.
 *
 * Available value commands: /tavily /corpus /output.
 *
 * Keybindings on the query field:
 *   Enter   → submit (or invoke slash command if input starts with `/`)
 *   Tab     → toggle reasoning mode (deep ↔ fast); when input starts with
 *             `/`, autocompletes to the unique matching command.
 *   Esc     → in clarifying mode: cancel pending plan and return to composer.
 *             Otherwise: clear current input.
 *   Ctrl-C  → quit
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState } from '../state';
import { useCommand } from '../hooks/useCommand';
import { TextInput } from './TextInput';

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
  { name: 'output', desc: 'Set output directory', kind: 'value' },
  { name: 'deep', desc: 'Use deep (chain) reasoning', kind: 'instant' },
  { name: 'fast', desc: 'Use fast (parallel) reasoning', kind: 'instant' },
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
  const defaultMode = state.config?.defaults.reasoningMode ?? 'deep';
  const [mode, setMode] = useState<'flat' | 'deep'>(defaultMode);
  const [field, setField] = useState<Field>('query');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [showHelp, setShowHelp] = useState(false);

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

  const tavilyOrigin = state.configOrigin?.tavilyKey ?? 'unset';
  const corpusOrigin = state.configOrigin?.corpusPath ?? 'unset';
  const outputOrigin = state.configOrigin?.outputDir ?? 'default';
  const hasTavily = tavilyOrigin !== 'unset';
  const hasCorpus = corpusOrigin !== 'unset';
  const hasSource = hasTavily || hasCorpus;
  const envLocked = tavilyOrigin === 'env';

  const clarifying = state.clarifyContext !== null;
  const parsedSlash = parseSlash(query);
  const inSlash = parsedSlash !== null;
  const matches = filterCommands(parsedSlash);

  // Query field input handling: Tab + Esc + Ctrl-C. TextInput owns
  // character entry. Tab autocompletes the slash command when in slash
  // mode; otherwise toggles reasoning mode (existing behavior).
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        dispatch({ type: 'quit' });
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
        if (!inSlash) {
          setMode((m) => (m === 'deep' ? 'flat' : 'deep'));
        }
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
    { isActive: field === 'query' },
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
    dispatch({ type: 'submit_query', query: trimmed, mode });
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
      else if (name === 'fast') setMode('flat');
      else if (name === 'quit') dispatch({ type: 'quit' });
      else if (name === 'help') setShowHelp(true);
      return;
    }
    // value command. Internal dispatch names stay tavily/corpus to match
    // the existing commands.ts + main.ts handlers + harness.json schema —
    // we map at the slash boundary only.
    if (value) {
      if (name === 'web') dispatch({ type: 'set_tavily_key', key: value });
      else if (name === 'scan') dispatch({ type: 'set_corpus_path', path: value });
      else if (name === 'output') dispatch({ type: 'set_output_dir', path: value });
      else if (name === 'model') dispatch({ type: 'set_model_path', path: value });
      else if (name === 'reranker') dispatch({ type: 'set_reranker_path', path: value });
      return;
    }
    // No value — open the inline editor pre-filled with the current value.
    if (name === 'web') {
      if (envLocked) return;
      setDraft(state.config?.sources.tavilyKey ?? '');
      setField('web');
    } else if (name === 'scan') {
      setDraft(state.config?.sources.corpusPath ?? '');
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
    }
  };

  const commitWeb = (): void => {
    dispatch({ type: 'set_tavily_key', key: draft.trim() });
    setField('query');
    setDraft('');
  };

  const commitScan = (): void => {
    dispatch({ type: 'set_corpus_path', path: draft.trim() });
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
      {/* Main row: query input or inline editor */}
      {field === 'query' ? (
        <Box>
          <Text>› </Text>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={submitQuery}
            focused
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

      {/* Chips row */}
      <Box marginTop={0}>
        <ModeChip mode={mode} />
        <Text>  </Text>
        <SourceChip
          label="Web"
          origin={tavilyOrigin}
          value={hasTavily ? 'set' : null}
          disabled={envLocked}
        />
        <Text>  </Text>
        <SourceChip
          label="Scan"
          origin={corpusOrigin}
          value={
            state.config?.sources.corpusPath
              ? state.corpusStatus
                ? `${state.corpusStatus.fileCount} files`
                : state.config.sources.corpusPath
              : null
          }
        />
        <Text>  </Text>
        <SourceChip
          label="Output"
          origin={outputOrigin}
          value={state.config?.sources.outputDir ?? null}
        />
        <Box flexGrow={1} />
        <HintRow
          field={field}
          hasSource={hasSource}
          inSlash={inSlash}
          clarifying={clarifying}
        />
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

const ModeChip = memo(function ModeChip({ mode }: { mode: 'flat' | 'deep' }): React.ReactElement {
  return (
    <Text>
      <Text color={mode === 'deep' ? 'cyan' : undefined} bold={mode === 'deep'}>
        {mode === 'deep' ? '◆' : '○'} Deep
      </Text>
      <Text dimColor>  </Text>
      <Text color={mode === 'flat' ? 'cyan' : undefined} bold={mode === 'flat'}>
        {mode === 'flat' ? '◆' : '○'} Fast
      </Text>
    </Text>
  );
});

const SourceChip = memo(function SourceChip({
  label,
  origin,
  value,
  disabled = false,
}: {
  label: string;
  origin: string;
  value: string | null;
  disabled?: boolean;
}): React.ReactElement {
  const configured = origin !== 'unset';
  const color = configured ? 'green' : 'gray';
  const tag =
    origin === 'env' ? ' (env)'
      : origin === 'cli' ? ' (cli)'
      : '';
  const suffix =
    !configured ? '—'
      : label === 'Scan' && value
        ? value
        : '✓';
  return (
    <Text>
      <Text color={color} dimColor={disabled}>
        {label} {suffix}
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
}: {
  field: Field;
  hasSource: boolean;
  inSlash: boolean;
  clarifying: boolean;
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
  if (!hasSource) {
    return <Text color="yellow">⚠ Add a source via /web or /scan</Text>;
  }
  return <Text dimColor>Tab toggle mode · / commands · ⏎ submit</Text>;
});
