/**
 * Repo-local terminal `report` tool with a grammar-forced structured `sources`
 * field.
 *
 * Why not `@lloyal-labs/rig`'s `reportTool`? Its constructor exposes only
 * `description` / `resultDescription` overrides — the parameter SCHEMA is fixed
 * to `{ result: string }`, so the required `sources` array can't be added
 * through it. We therefore mirror rig's contract here (same tool `name`, same
 * terminal no-op `execute()` semantics) and extend the schema.
 *
 * Contract, identical to rig's ReportTool: this is the pool's `terminalToolName`
 * ('report'). When an agent emits a call to it, the pool records the result and
 * marks the agent finished — the `execute()` code path is never reached; the
 * policy layer intercepts the call and extracts the arguments. Because the pool
 * builds the terminal grammar from THIS tool's schema (via the lazy tool-call
 * grammar), the `sources` field being `required` makes it grammar-forced: the
 * model must fill it to emit a schema-valid report. `SourceWeavingPolicy`
 * (harness.ts) then weaves those sources into the result string at capture (see
 * weave-sources.ts).
 */

import type { Operation } from "effection";
import { Tool } from "@lloyal-labs/lloyal-agents";
import type { JsonSchema } from "@lloyal-labs/lloyal-agents";
import type { WeaveSource } from "./weave-sources";

export interface StructuredReportOpts {
  /** Override the tool description shown in the agent's tool schema. */
  description?: string;
  /** Override the result parameter description. */
  resultDescription?: string;
}

export class StructuredReportTool extends Tool<{
  result: string;
  sources: WeaveSource[];
}> {
  readonly name = "report";
  readonly description: string;
  readonly parameters: JsonSchema;

  constructor(opts?: StructuredReportOpts) {
    super();
    this.description =
      opts?.description ??
      "Submit your final research findings with specific evidence, direct quotes, and data points. Cite each claim inline as [title](url) using the exact URL seen in tool results. Fill the sources field with the structured list of every source you used. State what you found AND what you checked but could not find. Do not summarize — preserve detail.";
    this.parameters = {
      type: "object",
      properties: {
        result: {
          type: "string",
          description:
            opts?.resultDescription ??
            "Detailed findings with direct quotes and data points. Cite each claim inline as [title](url) using the exact URL seen in tool results. Include what was found and what was not found.",
        },
        sources: {
          type: "array",
          description:
            "Every source you used: exact title and exact URL as seen in tool results. Empty array only if no URL sources exist.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
            },
            required: ["title", "url"],
          },
        },
      },
      required: ["result", "sources"],
    };
  }

  // Terminal no-op: the pool intercepts the call at the policy layer and never
  // reaches this body (mirrors rig's ReportTool.execute).
  *execute(): Operation<unknown> {
    return {};
  }
}

/** Shared instance wired into the research pool in place of rig's `reportTool`. */
export const structuredReportTool = new StructuredReportTool();
