export interface OpenAIAgentsToolCall {
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIAgentsRunContext {
  agentId?: string;
  runId?: string;
  [key: string]: unknown;
}

export interface OpenAIAgentsToolCallOutput {
  error?: string;
  [key: string]: unknown;
}

export type OpenAIAgentsRunTool = (
  toolCall: OpenAIAgentsToolCall,
  context: OpenAIAgentsRunContext
) => Promise<OpenAIAgentsToolCallOutput>;

/**
 * A single function tool's execution entry point in `@openai/agents` >= 0.8.x.
 *
 * In 0.8.x tool execution moved off `Agent.prototype._runTool` (which no longer
 * exists) into a free function in `@openai/agents-core` that ultimately calls
 * `tool.invoke(runContext, input, details)` on the tool object itself. `input`
 * is the raw JSON-encoded arguments string and the return value is the tool
 * output the model sees (a string, or a structured result). Governance attaches
 * by wrapping this per-tool `invoke` (see the hooks module) — the version-robust
 * hook point, since the tool object is the same across the ESM and CJS builds
 * whereas the module-level free function is not monkeypatchable.
 */
export type OpenAIAgentsFunctionToolInvoke = (
  this: unknown,
  runContext: unknown,
  input: string,
  details?: unknown
) => Promise<unknown>;

/**
 * The subset of a `@openai/agents` >= 0.8.x `FunctionTool` this SDK relies on to
 * attach governance. `type === "function"` distinguishes callable function
 * tools from hosted/computer/shell tools, which this hook does not wrap.
 */
export interface OpenAIAgentsFunctionTool {
  type: string;
  name: string;
  invoke: OpenAIAgentsFunctionToolInvoke;
}

/**
 * `Agent.prototype.getAllTools(runContext)` in `@openai/agents` >= 0.8.x —
 * resolves the tools exposed to the model for the current run. This SDK patches
 * it to wrap each returned function tool's {@link OpenAIAgentsFunctionToolInvoke}
 * with a pre-execution governance check.
 */
export type OpenAIAgentsGetAllTools = (this: unknown, runContext: unknown) => Promise<unknown[]>;
