import type {
  VercelAiToolDefinition,
  VercelAiToolExecutionOptions,
  VercelAiToolFactory
} from "../types/vercel-ai-adapter.js";
import type { GatewayClient } from "../gateway/client.js";
import { PolicyViolationError } from "../errors/policy-violation-error.js";
import { runWithAgentId } from "../lineage/agent-context-store.js";

export interface VercelAiSdkModule {
  tool: VercelAiToolFactory;
}

export interface VercelAiSdkPatchState {
  isPatched: boolean;
  originalToolFactory: VercelAiToolFactory | undefined;
  patchedModule: VercelAiSdkModule | undefined;
}

export const vercelAiSdkPatchState: VercelAiSdkPatchState = {
  isPatched: false,
  originalToolFactory: undefined,
  patchedModule: undefined
};

export function captureOriginalToolFactory(
  module: VercelAiSdkModule
): VercelAiToolFactory | undefined {
  const candidate = module.tool;
  if (typeof candidate !== "function") {
    return undefined;
  }

  vercelAiSdkPatchState.originalToolFactory ??= candidate;

  return vercelAiSdkPatchState.originalToolFactory;
}

export interface CreateWrappedExecuteOptions {
  approvalTimeoutMs: number;
  fallbackRunId: string;
  /** When set, tool execution runs inside runWithAgentId so child initAssembly auto-inherits parentAgentId. */
  agentId?: string;
}

export function recordToolResultNonBlocking(
  gatewayClient: GatewayClient,
  runId: string,
  output: unknown
): void {
  void gatewayClient.recordResult({ runId, output }).catch(() => undefined);
}

export function createWrappedExecute<TArgs, TResult>(
  originalExecute: (args: TArgs, options: VercelAiToolExecutionOptions) => Promise<TResult>,
  description: string,
  gatewayClient: GatewayClient,
  options: CreateWrappedExecuteOptions
): (args: TArgs, executionOptions: VercelAiToolExecutionOptions) => Promise<TResult> {
  return async function wrappedExecute(
    args: TArgs,
    executionOptions: VercelAiToolExecutionOptions
  ): Promise<TResult> {
    const runId = executionOptions.toolCallId ?? options.fallbackRunId;

    const executeOriginal = async (): Promise<TResult> => {
      const run = async (): Promise<TResult> => {
        const result = await originalExecute(args, executionOptions);
        recordToolResultNonBlocking(gatewayClient, runId, result);
        return result;
      };
      return options.agentId ? runWithAgentId(options.agentId, run) : run();
    };

    let decision;
    try {
      decision = await gatewayClient.check({
        action: "tool_call",
        toolName: description,
        args,
        runId
      });
    } catch {
      return executeOriginal();
    }

    if (decision.denied) {
      throw new PolicyViolationError(
        `Tool blocked by governance policy: ${decision.reason ?? "Denied"}`
      );
    }

    if (decision.pending) {
      let approval;
      try {
        approval = await gatewayClient.waitForApproval(
          description,
          runId,
          options.approvalTimeoutMs
        );
      } catch {
        return executeOriginal();
      }
      if (approval.denied) {
        throw new PolicyViolationError(
          `Approval rejected: ${approval.reason ?? "Rejected"}`
        );
      }
    }

    return executeOriginal();
  };
}

export interface CreatePatchedToolFactoryOptions {
  approvalTimeoutMs: number;
  fallbackRunId: string;
  agentId?: string;
}

export function createPatchedToolFactory(
  originalToolFactory: VercelAiToolFactory,
  gatewayClient: GatewayClient,
  options: CreatePatchedToolFactoryOptions
): VercelAiToolFactory {
  return function patchedTool<TArgs, TResult>(
    definition: VercelAiToolDefinition<TArgs, TResult>
  ): VercelAiToolDefinition<TArgs, TResult> {
    const toolResult = originalToolFactory(definition);

    if (!toolResult.execute) {
      return toolResult;
    }

    const description = toolResult.description ?? "unknown_tool";

    return {
      ...toolResult,
      execute: createWrappedExecute(
        toolResult.execute,
        description,
        gatewayClient,
        options
      )
    };
  };
}

export interface PatchVercelAiSdkOptions {
  gatewayClient: GatewayClient;
  approvalTimeoutMs?: number;
  fallbackRunId?: string;
  agentId?: string;
  loadModule?: () => Promise<VercelAiSdkModule | undefined>;
}

async function loadVercelAiSdkModule(): Promise<VercelAiSdkModule | undefined> {
  try {
    const moduleName = "ai";
    const module = (await import(moduleName)) as VercelAiSdkModule;
    return module;
  } catch {
    return undefined;
  }
}

export async function patchVercelAiSdk(
  options: PatchVercelAiSdkOptions
): Promise<boolean> {
  if (vercelAiSdkPatchState.isPatched) {
    return true;
  }

  const loadModule = options.loadModule ?? loadVercelAiSdkModule;
  const module = await loadModule();
  if (!module) {
    return false;
  }

  const originalToolFactory = captureOriginalToolFactory(module);
  if (!originalToolFactory) {
    return false;
  }

  module.tool = createPatchedToolFactory(
    originalToolFactory,
    options.gatewayClient,
    {
      approvalTimeoutMs: options.approvalTimeoutMs ?? 30_000,
      fallbackRunId: options.fallbackRunId ?? "vercel-ai-sdk",
      ...(options.agentId === undefined ? {} : { agentId: options.agentId })
    }
  );
  vercelAiSdkPatchState.isPatched = true;
  vercelAiSdkPatchState.patchedModule = module;
  return true;
}

export function unpatchVercelAiSdk(): boolean {
  if (!vercelAiSdkPatchState.isPatched) {
    return false;
  }
  if (!vercelAiSdkPatchState.patchedModule) {
    return false;
  }
  if (!vercelAiSdkPatchState.originalToolFactory) {
    return false;
  }

  vercelAiSdkPatchState.patchedModule.tool =
    vercelAiSdkPatchState.originalToolFactory;
  vercelAiSdkPatchState.isPatched = false;
  vercelAiSdkPatchState.patchedModule = undefined;
  return true;
}
