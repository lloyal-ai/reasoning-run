/**
 * reasoning.run/state — the renderer-neutral state surface.
 *
 * The pure `reduce` + `AppState` (and the state vocabulary) with NO Ink/React
 * dependency, so a host or an alternate UI (Artifact's desktop/web renderer,
 * the web Artifact) can derive UI state from the harness's `WorkflowEvent`
 * stream without dragging in the terminal renderer. The Ink `render` binding
 * stays behind the package's `bin` (terminal surface only).
 */
export { reduce } from "./tui-ink/reducer";
export * from "./tui-ink/state";
