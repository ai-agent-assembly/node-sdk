/**
 * OpenAI Agents SDK governance hook.
 *
 * Attaches pre-execution allow/deny to `@openai/agents` tool calls. Two hook
 * points are supported across upstream versions:
 *
 * - **>= 0.8.x (primary):** tool execution moved off `Agent.prototype._runTool`
 *   (removed) into a free function in `@openai/agents-core` that calls
 *   `tool.invoke(...)` on the tool object. That free function is not
 *   monkeypatchable (ESM const bindings; the internal caller does not route
 *   through the module export), so we hook `Agent.prototype.getAllTools` — a
 *   mutable prototype method called every turn — and wrap each returned function
 *   tool's `invoke` with a governance check. The wrap is on the tool object, so
 *   it holds across the ESM and CJS builds.
 * - **< 0.8.x (legacy):** the historical `Agent.prototype._runTool` method.
 *
 * When @openai/agents is installed but NEITHER hook point exists, the upstream
 * API has moved out from under us. We must NOT silently no-op (the AAASM-4797
 * bug: the removed-`_runTool` patch found no hook, returned false, and emitted
 * zero warning, leaving OpenAI Agents apps ungoverned in silence). Instead we
 * warn loudly on stderr and, under a fail-closed (enforce) posture, throw a
 * `ConfigurationError` rather than run ungoverned.
 */
import type {
  OpenAIAgentsFunctionTool,
  OpenAIAgentsFunctionToolInvoke,
  OpenAIAgentsGetAllTools,
  OpenAIAgentsRunContext,
  OpenAIAgentsRunTool,
  OpenAIAgentsToolCall,
  OpenAIAgentsToolCallOutput
} from "../types/openai-agents-adapter.js";
import type { GatewayClient } from "../gateway/client.js";
import { ConfigurationError } from "../errors/index.js";
import { hasOpenAIAgentsSDK } from "./openai-agents-detection.js";

export interface OpenAIAgentsAgentClass {
  prototype: {
    _runTool?: OpenAIAgentsRunTool;
    getAllTools?: OpenAIAgentsGetAllTools;
  };
}

/** Which upstream hook point `patchOpenAIAgents` attached to, for unpatch. */
export type OpenAIAgentsHookPoint = "getAllTools" | "runTool";

export interface OpenAIAgentsPatchState {
  isPatched: boolean;
  hookPoint: OpenAIAgentsHookPoint | undefined;
  originalRunTool: OpenAIAgentsRunTool | undefined;
  originalGetAllTools: OpenAIAgentsGetAllTools | undefined;
  patchedAgentClass: OpenAIAgentsAgentClass | undefined;
}

export const openAIAgentsPatchState: OpenAIAgentsPatchState = {
  isPatched: false,
  hookPoint: undefined,
  originalRunTool: undefined,
  originalGetAllTools: undefined,
  patchedAgentClass: undefined
};

/**
 * Tool objects whose `invoke` this SDK has already wrapped. `getAllTools` runs
 * every turn and returns the same tool objects each time, so this guards against
 * re-wrapping (which would stack the governance check N-deep). A `WeakSet` keeps
 * the tool object itself clean and lets it be garbage-collected normally.
 */
const governedFunctionTools = new WeakSet<object>();

export function captureOriginalRunTool(
  agentClass: OpenAIAgentsAgentClass
): OpenAIAgentsRunTool | undefined {
  const candidate = agentClass.prototype._runTool;
  if (!candidate) {
    return undefined;
  }

  openAIAgentsPatchState.originalRunTool ??= candidate;

  return openAIAgentsPatchState.originalRunTool;
}

export function parseToolCallArguments(toolCall: OpenAIAgentsToolCall): unknown {
  try {
    return JSON.parse(toolCall.function.arguments);
  } catch {
    return toolCall.function.arguments;
  }
}

/**
 * Parse a >= 0.8.x tool `invoke` input (a raw JSON-encoded arguments string)
 * into structured args for the governance `check`, falling back to the raw
 * string when it is not valid JSON — mirroring {@link parseToolCallArguments}.
 */
export function parseToolInputArguments(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export interface OpenAIAgentsToolCallContextMetadata {
  agentId: string | undefined;
  runId: string | undefined;
}

export function extractToolCallContextMetadata(
  context: OpenAIAgentsRunContext | undefined
): OpenAIAgentsToolCallContextMetadata {
  return {
    agentId: context?.agentId ?? undefined,
    runId: context?.runId ?? undefined
  };
}

export function formatDeniedToolCallOutput(
  reason: string | undefined,
  prefix: string
): OpenAIAgentsToolCallOutput {
  const detail = reason?.trim() ? reason : "denied";
  return { error: `${prefix}: ${detail}` };
}

/**
 * The >= 0.8.x `invoke` contract returns the tool output the model reads (a
 * string, or a structured result). A denial surfaces as a plain-text tool
 * output the model can act on, mirroring how the legacy `_runTool` path returned
 * `{ error }`.
 */
export function formatDeniedToolCallText(reason: string | undefined, prefix: string): string {
  const detail = reason?.trim() ? reason : "denied";
  return `${prefix}: ${detail}`;
}

export interface AwaitApprovalOptions {
  toolName: string;
  runId: string;
  timeoutMs: number;
}

export async function handlePendingApproval(
  gatewayClient: GatewayClient,
  options: AwaitApprovalOptions
): Promise<OpenAIAgentsToolCallOutput | undefined> {
  const approval = await gatewayClient.waitForApproval(
    options.toolName,
    options.runId,
    options.timeoutMs
  );

  if (!approval.denied) {
    return undefined;
  }

  return formatDeniedToolCallOutput(approval.reason, "Approval denied");
}

export function recordToolResultNonBlocking(
  gatewayClient: GatewayClient,
  runId: string,
  output: unknown
): void {
  void gatewayClient.recordResult({ runId, output }).catch(() => undefined);
}

export interface CreatePatchedRunToolOptions {
  fallbackRunId: string;
  approvalTimeoutMs: number;
}

export function createPatchedRunTool(
  originalRunTool: OpenAIAgentsRunTool,
  gatewayClient: GatewayClient,
  options: CreatePatchedRunToolOptions
): OpenAIAgentsRunTool {
  return async function patchedRunTool(
    this: unknown,
    toolCall: OpenAIAgentsToolCall,
    context: OpenAIAgentsRunContext
  ) {
    const toolName = toolCall.function.name;
    const args = parseToolCallArguments(toolCall);
    const metadata = extractToolCallContextMetadata(context);
    const runId = metadata.runId ?? options.fallbackRunId;

    const executeOriginal = async (): Promise<OpenAIAgentsToolCallOutput> => {
      const result = await originalRunTool.call(this, toolCall, context);
      recordToolResultNonBlocking(gatewayClient, runId, {
        toolName,
        args,
        result,
        agentId: metadata.agentId
      });
      return result;
    };

    // Let check / approval faults propagate (reject) instead of swallowing them
    // into a silent fail-open. A caller-supplied gatewayClient that throws on a
    // transport error must NOT be treated as ALLOW — this matches the
    // with-assembly / wrap-tool wrappers, whose un-caught check() rejects and
    // blocks the tool under enforce (AAASM-4137).
    const decision = await gatewayClient.check({
      action: "tool_call",
      toolName,
      args,
      runId
    });

    if (decision.denied) {
      return formatDeniedToolCallOutput(decision.reason, "Blocked by governance policy");
    }

    if (decision.pending) {
      const pendingOutput = await handlePendingApproval(gatewayClient, {
        toolName,
        runId,
        timeoutMs: options.approvalTimeoutMs
      });
      if (pendingOutput) {
        return pendingOutput;
      }
    }

    return executeOriginal();
  };
}

export interface CreateGovernedInvokeOptions {
  fallbackRunId: string;
  approvalTimeoutMs: number;
}

/**
 * Wrap a >= 0.8.x function tool's `invoke` with a pre-execution governance
 * check. Fail-closed semantics match {@link createPatchedRunTool}: a `check` /
 * approval fault propagates (rejects) rather than being swallowed into a silent
 * fail-open, so a caller whose gateway throws on a transport error blocks the
 * tool under enforce rather than running it.
 */
export function createGovernedInvoke(
  originalInvoke: OpenAIAgentsFunctionToolInvoke,
  gatewayClient: GatewayClient,
  toolName: string,
  options: CreateGovernedInvokeOptions
): OpenAIAgentsFunctionToolInvoke {
  return async function governedInvoke(
    this: unknown,
    runContext: unknown,
    input: string,
    details?: unknown
  ): Promise<unknown> {
    const args = parseToolInputArguments(input);
    const runId = options.fallbackRunId;

    const decision = await gatewayClient.check({
      action: "tool_call",
      toolName,
      args,
      runId
    });

    if (decision.denied) {
      return formatDeniedToolCallText(decision.reason, "Blocked by governance policy");
    }

    if (decision.pending) {
      const approval = await gatewayClient.waitForApproval(
        toolName,
        runId,
        options.approvalTimeoutMs
      );
      if (approval.denied) {
        return formatDeniedToolCallText(approval.reason, "Approval denied");
      }
    }

    const result = await originalInvoke.call(this, runContext, input, details);
    recordToolResultNonBlocking(gatewayClient, runId, {
      toolName,
      args,
      result
    });
    return result;
  };
}

function isGovernableFunctionTool(value: unknown): value is OpenAIAgentsFunctionTool {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "function" &&
    typeof candidate.invoke === "function" &&
    typeof candidate.name === "string"
  );
}

/**
 * Wrap a single tool's `invoke` in place, idempotently. Non-function tools
 * (hosted / computer / shell) and already-governed tools are left untouched.
 */
export function wrapFunctionToolInvoke(
  candidate: unknown,
  gatewayClient: GatewayClient,
  options: CreateGovernedInvokeOptions
): void {
  if (!isGovernableFunctionTool(candidate)) {
    return;
  }
  if (governedFunctionTools.has(candidate)) {
    return;
  }
  candidate.invoke = createGovernedInvoke(candidate.invoke, gatewayClient, candidate.name, options);
  governedFunctionTools.add(candidate);
}

function createPatchedGetAllTools(
  originalGetAllTools: OpenAIAgentsGetAllTools,
  gatewayClient: GatewayClient,
  options: CreateGovernedInvokeOptions
): OpenAIAgentsGetAllTools {
  return async function patchedGetAllTools(this: unknown, runContext: unknown): Promise<unknown[]> {
    const tools = await originalGetAllTools.call(this, runContext);
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        wrapFunctionToolInvoke(tool, gatewayClient, options);
      }
    }
    return tools;
  };
}

export interface PatchOpenAIAgentsOptions {
  gatewayClient: GatewayClient;
  approvalTimeoutMs?: number;
  fallbackRunId?: string;
  /**
   * When the expected hook point is absent (upstream API moved), throw a
   * `ConfigurationError` instead of only warning. Set from the caller's
   * fail-closed (enforce) posture so an enforce agent fails loudly rather than
   * running ungoverned (AAASM-4797).
   */
  failClosed?: boolean;
  loadAgentClass?: () => Promise<OpenAIAgentsAgentClass | undefined>;
}

async function loadAgentClassFromSdk(): Promise<OpenAIAgentsAgentClass | undefined> {
  if (!hasOpenAIAgentsSDK()) {
    return undefined;
  }

  try {
    const moduleName = "@openai/agents";
    const module = (await import(moduleName)) as { Agent?: OpenAIAgentsAgentClass };
    return module.Agent;
  } catch {
    return undefined;
  }
}

/**
 * Loud, un-silenceable signal that @openai/agents is installed but its
 * tool-execution API has moved past every hook point this SDK knows — the
 * failure mode AAASM-4797 closes. Written straight to `process.stderr` (not a
 * swappable logger), mirroring the AAASM-4769 no-op-enforcement warning.
 */
function warnOpenAIAgentsHookPointMissing(): void {
  process.stderr.write(
    `[agent-assembly] WARNING: @openai/agents is installed but neither the ` +
      `>= 0.8.x tool-execution hook (Agent.prototype.getAllTools) nor the legacy ` +
      `< 0.8.x hook (Agent.prototype._runTool) was found — the installed ` +
      `version's tool-execution API has moved. OpenAI Agents tool calls will ` +
      `NOT be governed by this SDK: a policy DENY will NOT block a tool call. ` +
      `Pin @openai/agents to a supported version or upgrade @agent-assembly/sdk ` +
      `(AAASM-4797).\n`
  );
}

function patchViaGetAllTools(
  agentClass: OpenAIAgentsAgentClass,
  getAllTools: OpenAIAgentsGetAllTools,
  gatewayClient: GatewayClient,
  options: CreateGovernedInvokeOptions
): void {
  openAIAgentsPatchState.originalGetAllTools ??= getAllTools;
  agentClass.prototype.getAllTools = createPatchedGetAllTools(
    openAIAgentsPatchState.originalGetAllTools,
    gatewayClient,
    options
  );
  openAIAgentsPatchState.isPatched = true;
  openAIAgentsPatchState.hookPoint = "getAllTools";
  openAIAgentsPatchState.patchedAgentClass = agentClass;
}

function patchViaRunTool(
  agentClass: OpenAIAgentsAgentClass,
  originalRunTool: OpenAIAgentsRunTool,
  gatewayClient: GatewayClient,
  options: CreateGovernedInvokeOptions
): void {
  agentClass.prototype._runTool = createPatchedRunTool(originalRunTool, gatewayClient, options);
  openAIAgentsPatchState.isPatched = true;
  openAIAgentsPatchState.hookPoint = "runTool";
  openAIAgentsPatchState.patchedAgentClass = agentClass;
}

export async function patchOpenAIAgents(options: PatchOpenAIAgentsOptions): Promise<boolean> {
  if (openAIAgentsPatchState.isPatched) {
    return true;
  }

  const loadAgentClass = options.loadAgentClass ?? loadAgentClassFromSdk;
  const agentClass = await loadAgentClass();
  if (!agentClass) {
    // @openai/agents is not installed / did not load. A bare dependency install
    // must stay zero-config (AAASM-1847) — return silently, not loudly.
    return false;
  }

  const invokeOptions: CreateGovernedInvokeOptions = {
    approvalTimeoutMs: options.approvalTimeoutMs ?? 30_000,
    fallbackRunId: options.fallbackRunId ?? "openai-agents"
  };

  // Prefer the >= 0.8.x hook; fall back to the legacy < 0.8.x `_runTool`.
  const getAllTools = agentClass.prototype.getAllTools;
  if (typeof getAllTools === "function") {
    patchViaGetAllTools(agentClass, getAllTools, options.gatewayClient, invokeOptions);
    return true;
  }

  const originalRunTool = captureOriginalRunTool(agentClass);
  if (originalRunTool) {
    patchViaRunTool(agentClass, originalRunTool, options.gatewayClient, invokeOptions);
    return true;
  }

  // Neither hook point exists: the upstream API moved. Never silently no-op.
  warnOpenAIAgentsHookPointMissing();
  if (options.failClosed) {
    throw new ConfigurationError(
      `@openai/agents is installed but no supported tool-execution hook point ` +
        `(Agent.prototype.getAllTools or Agent.prototype._runTool) was found, so ` +
        `this SDK cannot govern OpenAI Agents tool calls. Refusing to register ` +
        `under enforce rather than run ungoverned. Pin @openai/agents to a ` +
        `supported version, upgrade @agent-assembly/sdk, or set enforcementMode ` +
        `to "observe"/"disabled" (AAASM-4797).`
    );
  }
  return false;
}

export function unpatchOpenAIAgents(): boolean {
  if (!openAIAgentsPatchState.isPatched || !openAIAgentsPatchState.patchedAgentClass) {
    return false;
  }

  const agentClass = openAIAgentsPatchState.patchedAgentClass;

  if (
    openAIAgentsPatchState.hookPoint === "getAllTools" &&
    openAIAgentsPatchState.originalGetAllTools
  ) {
    // Restores the prototype method; tools already wrapped in place keep their
    // governance (they stay in the WeakSet and are not re-wrapped), which is the
    // safe direction — unpatch is a test/teardown aid, not a governance-off switch.
    agentClass.prototype.getAllTools = openAIAgentsPatchState.originalGetAllTools;
  } else if (
    openAIAgentsPatchState.hookPoint === "runTool" &&
    openAIAgentsPatchState.originalRunTool
  ) {
    agentClass.prototype._runTool = openAIAgentsPatchState.originalRunTool;
  } else {
    return false;
  }

  openAIAgentsPatchState.isPatched = false;
  openAIAgentsPatchState.hookPoint = undefined;
  openAIAgentsPatchState.patchedAgentClass = undefined;
  return true;
}
