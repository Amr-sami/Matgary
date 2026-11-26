import type { Permission } from "@/lib/permissions";

import type { ToolContext } from "../context";
import type { AiBlock } from "../responses";

/**
 * Shared types for the tool registry.
 *
 * Tool authoring contract:
 *   1. Each tool is a `Tool<Args>`.
 *   2. `definition` is the OpenAI/Groq function-tool spec the model sees.
 *   3. `handler` runs server-side. It receives `(ctx, args)` and returns
 *      JSON-serialisable data OR a `ToolResult` with pre-formed UI blocks.
 *   4. If `requiredPermission` is set, the orchestrator refuses the call
 *      before dispatching when the user lacks the permission (returns an
 *      error result the model can read + apologise over).
 *
 * Keep schemas STRICT. The model is better at calling well-typed tools; a
 * loose `object` with `additionalProperties: true` is a footgun.
 */

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
  };
}

/** What a handler may return to the agent. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: true; blocks: AiBlock[] }
  | { ok: false; error: string; reason?: string };

export interface Tool {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
  requiredPermission?: Permission;
  /** When true the orchestrator will NOT execute this tool for an owner-only
   *  context (e.g. "all branches" roll-ups) — tool decides what to do. */
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** OpenAI-compatible definition the model receives. */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
