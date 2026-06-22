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
  /**
   * The module object whose `tool` factory is governed. When the loaded `ai`
   * package is a real ES module its namespace is frozen (assignment to a named
   * export throws), so this is a mutable **shim copy** (`{ ...module, tool:
   * governed }`) rather than the frozen original — see `applyGovernedToolFactory`.
   */
  patchedModule: VercelAiSdkModule | undefined;
  /**
   * True only when `tool` was assigned back onto the loaded module object (a
   * writable plain object); false when a frozen ESM namespace forced a shim copy.
   * Governs whether `unpatchVercelAiSdk` writes the original factory back —
   * there is nothing to restore on the frozen original in the shim case.
   */
  mutatedOriginal: boolean;
}

export const vercelAiSdkPatchState: VercelAiSdkPatchState = {
  isPatched: false,
  originalToolFactory: undefined,
  patchedModule: undefined,
  mutatedOriginal: false
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

/**
 * Install `governed` as the module's `tool` factory without ever assigning to a
 * frozen ESM namespace.
 *
 * A real `ai` package loaded via `import()` is an ES module: its namespace is an
 * exotic object whose named exports are non-writable, so `module.tool = …` throws
 * `Cannot assign to read only property 'tool'` (AAASM-3532). We therefore attempt
 * the in-place assignment only as a fast path for writable plain objects (the
 * shape used by the unit suite's `loadModule` fakes) and fall back to a mutable
 * **shim copy** for the frozen-namespace case — the same `{ tool: aiModule.tool }`
 * shim the AAASM-3525 integration driver proved works. The returned module is what
 * downstream consumers read the governed factory from (`patchedModule.tool`).
 */
function applyGovernedToolFactory(
  module: VercelAiSdkModule,
  governed: VercelAiToolFactory
): { patchedModule: VercelAiSdkModule; mutatedOriginal: boolean } {
  if (Object.isExtensible(module)) {
    try {
      module.tool = governed;
      return { patchedModule: module, mutatedOriginal: true };
    } catch {
      // Some non-extensible-but-reported-extensible exotic objects still reject
      // the write; fall through to the shim copy below.
    }
  }

  return {
    patchedModule: { ...module, tool: governed },
    mutatedOriginal: false
  };
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

  const governed = createPatchedToolFactory(
    originalToolFactory,
    options.gatewayClient,
    {
      approvalTimeoutMs: options.approvalTimeoutMs ?? 30_000,
      fallbackRunId: options.fallbackRunId ?? "vercel-ai-sdk",
      ...(options.agentId === undefined ? {} : { agentId: options.agentId })
    }
  );

  const { patchedModule, mutatedOriginal } = applyGovernedToolFactory(
    module,
    governed
  );

  vercelAiSdkPatchState.isPatched = true;
  vercelAiSdkPatchState.patchedModule = patchedModule;
  vercelAiSdkPatchState.mutatedOriginal = mutatedOriginal;
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

  // Only restore when we mutated a writable module in place. For the frozen-ESM
  // shim path the original `ai` namespace was never touched, so there is nothing
  // to write back — and attempting it would re-throw the AAASM-3532 crash.
  if (vercelAiSdkPatchState.mutatedOriginal) {
    vercelAiSdkPatchState.patchedModule.tool =
      vercelAiSdkPatchState.originalToolFactory;
  }
  vercelAiSdkPatchState.isPatched = false;
  vercelAiSdkPatchState.patchedModule = undefined;
  vercelAiSdkPatchState.mutatedOriginal = false;
  return true;
}
