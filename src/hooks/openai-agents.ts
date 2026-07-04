import type {
  OpenAIAgentsRunContext,
  OpenAIAgentsRunTool,
  OpenAIAgentsToolCall,
  OpenAIAgentsToolCallOutput
} from "../types/openai-agents-adapter.js";
import type { GatewayClient } from "../gateway/client.js";
import { hasOpenAIAgentsSDK } from "./openai-agents-detection.js";

export interface OpenAIAgentsAgentClass {
  prototype: {
    _runTool?: OpenAIAgentsRunTool;
  };
}

export interface OpenAIAgentsPatchState {
  isPatched: boolean;
  originalRunTool: OpenAIAgentsRunTool | undefined;
  patchedAgentClass: OpenAIAgentsAgentClass | undefined;
}

export const openAIAgentsPatchState: OpenAIAgentsPatchState = {
  isPatched: false,
  originalRunTool: undefined,
  patchedAgentClass: undefined
};

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
      return formatDeniedToolCallOutput(
        decision.reason,
        "Blocked by governance policy"
      );
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

export interface PatchOpenAIAgentsOptions {
  gatewayClient: GatewayClient;
  approvalTimeoutMs?: number;
  fallbackRunId?: string;
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

export async function patchOpenAIAgents(
  options: PatchOpenAIAgentsOptions
): Promise<boolean> {
  if (openAIAgentsPatchState.isPatched) {
    return true;
  }

  const loadAgentClass = options.loadAgentClass ?? loadAgentClassFromSdk;
  const agentClass = await loadAgentClass();
  if (!agentClass) {
    return false;
  }

  const originalRunTool = captureOriginalRunTool(agentClass);
  if (!originalRunTool) {
    return false;
  }

  agentClass.prototype._runTool = createPatchedRunTool(
    originalRunTool,
    options.gatewayClient,
    {
      approvalTimeoutMs: options.approvalTimeoutMs ?? 30_000,
      fallbackRunId: options.fallbackRunId ?? "openai-agents"
    }
  );
  openAIAgentsPatchState.isPatched = true;
  openAIAgentsPatchState.patchedAgentClass = agentClass;
  return true;
}

export function unpatchOpenAIAgents(): boolean {
  if (!openAIAgentsPatchState.isPatched) {
    return false;
  }
  if (!openAIAgentsPatchState.patchedAgentClass) {
    return false;
  }
  if (!openAIAgentsPatchState.originalRunTool) {
    return false;
  }

  openAIAgentsPatchState.patchedAgentClass.prototype._runTool =
    openAIAgentsPatchState.originalRunTool;
  openAIAgentsPatchState.isPatched = false;
  openAIAgentsPatchState.patchedAgentClass = undefined;
  return true;
}
