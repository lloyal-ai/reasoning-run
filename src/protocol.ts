/**
 * reasoning.run/protocol — the harness's wire vocabulary.
 *
 * Its `WorkflowEvent` union (down) + `Command` union (up) — the two halves of
 * the headless interface `harness(ctx, events, commands)` speaks — plus the
 * config schema a runner resolves and hands the harness. A host or surface
 * imports these to speak the protocol without depending on the UI.
 */
export type { StepEvent, WorkflowEvent } from "./tui-ink/events";
export type { Command } from "./tui-ink/commands";
export { loadConfig, saveConfig } from "./tui-ink/config";
export type {
  Config,
  ConfigSources,
  ConfigDefaults,
  ConfigModel,
  ConfigOrigin,
  LoadedConfig,
  CliOverrides,
  SaveResult,
} from "./tui-ink/config";
