import React from 'react';
import { Box, Static, Text } from 'ink';
import type { WorkflowEvent } from '../events';
import type { ScrollbackItem } from '../state';
import { useEventStream } from '../hooks/useEventStream';
import { CommandContext, type CommandDispatch } from '../hooks/useCommand';
import type { EventBus } from '../event-bus';
import { Header } from './Header';
import { FrozenAgentPanel } from './FrozenAgentPanel';
import { Narrative } from './Narrative';
import { Synth } from './Synth';
import { Answer } from './Answer';
import { Footer } from './Footer';
import { Composer } from './Composer';
import { PlanReview } from './PlanReview';
import { PlanningSpinner } from './PlanningSpinner';
import { Discovering } from './Discovering';
import { ClarifyPanel } from './ClarifyPanel';
import { BootStatus } from './BootStatus';

export interface AppProps {
  bus: EventBus<WorkflowEvent>;
  dispatch: CommandDispatch;
  /** Pre-render events — applied through the reducer before the first
   *  paint so the tree never renders with stale state. The bus buffers
   *  sends that happen before useEffect subscribes, so late events don't
   *  need bootstrapping. */
  bootstrap?: WorkflowEvent[];
}

export function App({ bus, dispatch, bootstrap }: AppProps): React.ReactElement {
  const state = useEventStream(bus, bootstrap);
  const showHeader =
    state.uiPhase !== 'composer' &&
    state.uiPhase !== 'boot' &&
    state.uiPhase !== 'downloading' &&
    state.uiPhase !== 'loading' &&
    state.uiPhase !== 'discovering' &&
    state.uiPhase !== 'planning' &&
    state.uiPhase !== 'plan_review' &&
    state.uiPhase !== 'clarifying';  // components below render their own header

  const showResults = state.uiPhase === 'research' || state.uiPhase === 'done';
  // The composer dock persists through the running phases: its input row
  // becomes the run status line and the PLAN/START pill morphs into the
  // run controls (WRAP UP / STOP). research → done keeps it mounted, so
  // the pill morphs back for the follow-up with no unmount flash.
  const showComposer =
    state.uiPhase === 'composer' ||
    state.uiPhase === 'done' ||
    state.uiPhase === 'clarifying' ||
    state.uiPhase === 'boot_error' ||
    state.uiPhase === 'discovering' ||
    state.uiPhase === 'planning' ||
    state.uiPhase === 'research';

  return (
    <CommandContext.Provider value={dispatch}>
      <Static items={state.scrollback}>
        {(item: ScrollbackItem) => {
          if (item.kind === 'agent') {
            return (
              <Box key={item.key} paddingX={2}>
                <FrozenAgentPanel agent={item.agent} />
              </Box>
            );
          }
          // kind === 'synth'
          return (
            <Box key={item.key} flexDirection="column" paddingX={2} marginBottom={1}>
              <Text dimColor>───────────────────────────────────────</Text>
              <Box paddingLeft={2} marginTop={1}>
                <Text>{item.body}</Text>
              </Box>
            </Box>
          );
        }}
      </Static>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {showHeader && <Header query={state.query} warm={state.warm} />}
        {(state.uiPhase === 'downloading' ||
          state.uiPhase === 'loading' ||
          state.uiPhase === 'boot_error') && (
          <BootStatus state={state} />
        )}
        {state.uiPhase === 'discovering' && <Discovering state={state} />}
        {state.uiPhase === 'planning' && <PlanningSpinner state={state} />}
        {state.uiPhase === 'plan_review' && <PlanReview state={state} />}
        {state.uiPhase === 'clarifying' && <ClarifyPanel state={state} />}
        {showResults && <Narrative state={state} />}
        {showResults && <Synth state={state} />}
        {state.uiPhase === 'done' && <Answer state={state} />}
        {showComposer && <Composer state={state} />}
        <Footer state={state} />
      </Box>
    </CommandContext.Provider>
  );
}
