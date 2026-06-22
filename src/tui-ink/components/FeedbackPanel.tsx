/**
 * /feedback flow — a Composer-local overlay (not a uiPhase). Three steps:
 *   1. message  — single-line input (pre-filled from inline arg)
 *   2. errors   — consent to attach scrubbed session errors (only if any)
 *   3. confirm  — open the prefilled GitHub issue in the browser
 *   4. opened   — keep the URL visible for manual copy, Enter closes
 *
 * Nothing is sent here: dispatching open_feedback only opens a prefilled
 * issue the user reviews and submits themselves.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput';
import { useCommand } from '../hooks/useCommand';
import type { AppState } from '../state';
import {
  buildFeedbackBody, buildIssueUrl, feedbackTitle, type ScrubCtx,
} from '../feedback';

export interface FeedbackPanelProps {
  state: AppState;
  initialMessage: string;
  onClose: () => void;
}

type Step = 'message' | 'errors' | 'confirm' | 'opened';

export function FeedbackPanel({ state, initialMessage, onClose }: FeedbackPanelProps): React.ReactElement {
  const dispatch = useCommand();
  const [step, setStep] = useState<Step>('message');
  const [message, setMessage] = useState(initialMessage);
  const [includeErrors, setIncludeErrors] = useState(false);
  const [openUrl, setOpenUrl] = useState('');
  const [wasTruncated, setWasTruncated] = useState(false);

  const errorCount = state.errors.length;

  const scrubCtx: ScrubCtx = {
    query: state.query || undefined,
    homeDir: process.env.HOME ?? process.env.USERPROFILE ?? undefined,
    paths: [
      state.config?.model.path,
      state.config?.model.reranker,
      state.config?.sources.corpusPath,
      state.config?.sources.outputDir,
    ].filter((p): p is string => !!p),
  };

  const compose = (withErrors: boolean) => {
    // One source of truth for the message so the body and the URL title agree
    // (the message is guaranteed non-empty by the step-1 gate; the fallback is
    // defensive only).
    const msg = message.trim() || 'feedback';
    const { body, truncated } = buildFeedbackBody({
      message: msg,
      env: state.env,
      config: state.config,
      mode: state.mode,
      errors: state.errors,
      includeErrors: withErrors,
      scrubCtx,
    });
    const url = buildIssueUrl({ title: feedbackTitle(msg), body });
    return { url, truncated };
  };

  const goOpen = (withErrors: boolean) => {
    const { url, truncated } = compose(withErrors);
    setOpenUrl(url);
    setWasTruncated(truncated);
    dispatch({ type: 'open_feedback', url });
    setStep('opened');
  };

  // Step 1: message input handled by TextInput (Enter advances, Esc cancels).
  if (step === 'message') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Send feedback (opens a prefilled GitHub issue you review &amp; submit)</Text>
        <Box>
          <Text color="yellow">Your feedback › </Text>
          <TextInput
            value={message}
            onChange={setMessage}
            onSubmit={() => {
              if (!message.trim()) { onClose(); return; }
              setStep(errorCount > 0 ? 'errors' : 'confirm');
            }}
            onCancel={onClose}
            focused
            placeholder="What worked, what didn't…"
          />
        </Box>
        <Text dimColor>Enter to continue · Esc to cancel</Text>
      </Box>
    );
  }

  // Step 2: error-attach consent (only reached when errorCount > 0).
  if (step === 'errors') {
    return (
      <Box flexDirection="column">
        <ErrorConsent
          count={errorCount}
          onYes={() => { setIncludeErrors(true); setStep('confirm'); }}
          onNo={() => { setIncludeErrors(false); setStep('confirm'); }}
          onCancel={onClose}
        />
      </Box>
    );
  }

  // Step 3: open-confirm.
  if (step === 'confirm') {
    return (
      <Box flexDirection="column">
        <OpenConfirm
          includeErrors={includeErrors}
          errorCount={errorCount}
          onYes={() => goOpen(includeErrors)}
          onCancel={onClose}
        />
      </Box>
    );
  }

  // Step 4: opened — keep URL visible for manual copy.
  return (
    <Box flexDirection="column">
      <Text color="green">Opened a prefilled GitHub issue in your browser — review it and click “Submit new issue”.</Text>
      {wasTruncated ? (
        <Text color="yellow">Note: your message/errors were shortened to fit GitHub's URL limit.</Text>
      ) : null}
      <Text dimColor>If your browser didn't open, copy this URL:</Text>
      <Text wrap="wrap">{openUrl}</Text>
      <Text dimColor>Enter to close</Text>
      <CloseOnEnter onClose={onClose} />
    </Box>
  );
}

function ErrorConsent({ count, onYes, onNo, onCancel }: {
  count: number; onYes: () => void; onNo: () => void; onCancel: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (input === 'y' || input === 'Y') onYes();
    else if (input === 'n' || input === 'N' || key.return) onNo();
  });
  return (
    <Box flexDirection="column">
      <Text>Attach {count} error{count === 1 ? '' : 's'} from this session? They'll appear in a <Text color="red">public</Text> GitHub issue (scrubbed: messages only).</Text>
      <Text dimColor>y = attach · n / Enter = don't attach · Esc = cancel</Text>
    </Box>
  );
}

function OpenConfirm({ includeErrors, errorCount, onYes, onCancel }: {
  includeErrors: boolean; errorCount: number; onYes: () => void; onCancel: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') onCancel();
    else if (key.return || input === 'y' || input === 'Y') onYes();
  });
  const errNote = includeErrors && errorCount > 0 ? ` with ${errorCount} error(s)` : '';
  return (
    <Box flexDirection="column">
      <Text>Open a prefilled GitHub issue{errNote} in your browser to review &amp; submit?</Text>
      <Text dimColor>Enter / y = open · n / Esc = cancel</Text>
    </Box>
  );
}

function CloseOnEnter({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput((_input, key) => { if (key.return || key.escape) onClose(); });
  return <Text> </Text>;
}
