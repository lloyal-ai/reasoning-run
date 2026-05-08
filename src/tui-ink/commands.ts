/**
 * UI → main.ts command boundary.
 *
 * The Ink component tree dispatches commands through the `useCommand`
 * hook; main.ts drains them from an Effection Signal and runs the
 * corresponding Operation (runPlanner, runResearch, saveConfig, ...).
 *
 * Keep the union small and explicit. No generic "send arbitrary event"
 * escape hatch — that's what makes the UI <-> harness boundary auditable.
 */

export type Command =
  | { type: 'submit_query'; query: string; mode: 'flat' | 'deep' }
  | { type: 'submit_clarification'; answer: string }
  | { type: 'accept_plan' }
  | { type: 'cancel_plan' }
  | { type: 'edit_plan'; query: string }
  | { type: 'change_mode'; mode: 'flat' | 'deep' }
  | { type: 'update_task_description'; index: number; description: string }
  | { type: 'add_task'; afterIndex: number }
  | { type: 'delete_task'; index: number }
  | { type: 'move_task'; from: number; to: number }
  | { type: 'set_tavily_key'; key: string }
  | { type: 'set_corpus_path'; path: string }
  | { type: 'set_output_dir'; path: string }
  | { type: 'set_model_path'; path: string }
  | { type: 'set_reranker_path'; path: string }
  | { type: 'quit' };
