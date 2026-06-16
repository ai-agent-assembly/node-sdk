import { createRequire } from "node:module";
import type { Adapter } from "../adapters/adapter.js";
import type {
  AssemblyCallbackHandler,
  WrapToolWithAssemblyOptions
} from "../adapters/langchain/index.js";
import {
  createNativeGatewayClient,
  createNoopGatewayClient,
  type GatewayClient
} from "../gateway/client.js";
import { createNativeClient, type NativeClient } from "../native/client.js";
import type { AssemblyConfig } from "../types/assembly-config.js";
import type { AssemblyContext } from "../types/assembly-context.js";
import { ENFORCEMENT_MODES } from "../types/enforcement-mode.js";
import type {
  LangChainCallbackHandlerLike,
  LangChainToolLike
} from "../types/langchain-adapter.js";
import { hasVercelAiSdk } from "../hooks/ai-sdk-detection.js";
import { patchVercelAiSdk } from "../hooks/ai-sdk.js";
import { hasLangGraph } from "../hooks/langgraph-detection.js";
import { patchLangGraph } from "../hooks/langgraph.js";
import { hasMastra } from "../hooks/mastra-detection.js";
import { patchMastra } from "../hooks/mastra.js";
import { hasOpenAIAgentsSDK } from "../hooks/openai-agents-detection.js";
import { patchOpenAIAgents } from "../hooks/openai-agents.js";
import { currentAgentId } from "../lineage/index.js";
import { resolveApiKey, resolveGatewayUrl } from "./gateway-resolver.js";

const requireFromCwd = createRequire(`${process.cwd()}/`);

/** Env-var fallback for ``gatewayUrl`` read at ``initAssembly`` entry. */
export const ENV_GATEWAY_URL = "AA_GATEWAY_URL";
/** Env-var fallback for ``controlPlaneUrl`` read at ``initAssembly`` entry. */
export const ENV_CONTROL_PLANE_URL = "AA_CONTROL_PLANE_URL";

function buildRegistrationEvent(config: AssemblyConfig): Record<string, string> {
  const event: Record<string, string> = { event_type: "register" };
  if (config.parentAgentId !== undefined) event.parent_agent_id = config.parentAgentId;
  if (config.teamId !== undefined) event.team_id = config.teamId;
  if (config.delegationReason !== undefined) event.delegation_reason = config.delegationReason;
  if (config.spawnedByTool !== undefined) event.spawned_by_tool = config.spawnedByTool;
  // AAASM-1561: per-agent enforcement_mode override. Sent only when the
  // caller set it explicitly so a pre-feature SDK call produces a pre-feature
  // wire shape. The gateway's REST → gRPC bridge maps the snake_case token
  // onto RegisterRequest.enforcement_mode (proto enum) per AAASM-1555.
  if (config.enforcementMode !== undefined) event.enforcement_mode = config.enforcementMode;
  return event;
}

export function createClient(config: AssemblyConfig): GatewayClient {
  const mode = config.mode ?? "auto";
  if (config.gatewayClient) {
    return config.gatewayClient;
  }

  // HTTP routes use controlPlaneUrl when set, otherwise fall back to the
  // resolved gatewayUrl so pre-feature callers keep their existing base URL.
  const httpBaseUrl = config.controlPlaneUrl ?? config.gatewayUrl;

  // AAASM-3050: in napi-inprocess mode, route `check()` through the native
  // runtime so a reachable aa-runtime's DENY actually blocks a tool. The
  // native primitive fails open when the runtime is absent or slow, and the
  // gateway client swallows local faults, so this never blocks without a
  // runtime — preserving the pre-feature fail-open behavior.
  if (mode === "napi-inprocess") {
    const nativeClient = createNativeClient({
      gateway: config.gatewayUrl ?? "",
      apiKey: config.apiKey ?? "",
      mode: "napi-inprocess"
    });
    return createNativeGatewayClient(mode, nativeClient, config.agentId, httpBaseUrl);
  }

  return createNoopGatewayClient(mode, httpBaseUrl);
}

function isPackageInstalled(packageName: string): boolean {
  try {
    requireFromCwd.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

export function detectFrameworks(): string[] {
  const detected: string[] = [];

  if (isPackageInstalled("@langchain/core")) {
    detected.push("langchain-js");
  }
  if (hasVercelAiSdk()) {
    detected.push("vercel-ai-sdk");
  }
  if (hasOpenAIAgentsSDK()) {
    detected.push("openai-agents");
  }
  if (hasLangGraph()) {
    detected.push("langgraph-js");
  }
  if (hasMastra()) {
    detected.push("mastra");
  }

  return detected;
}

function createAdapter(id: string): Adapter {
  return {
    id,
    apply: async () => undefined
  };
}

export async function registerAdapters(frameworks: readonly string[]): Promise<Adapter[]> {
  const adapters = frameworks.map((framework) => createAdapter(framework));
  for (const adapter of adapters) {
    await adapter.apply();
  }
  return adapters;
}

export async function startNetworkLayerIfNeeded(
  client: GatewayClient,
  config: AssemblyConfig
): Promise<void> {
  if (config.mode === "sdk-only") {
    return;
  }

  await client.start();
}

function ensureLangChainCallbacks(config: AssemblyConfig): LangChainCallbackHandlerLike[] {
  config.langchain ??= {};
  config.langchain.callbacks ??= [];

  return config.langchain.callbacks;
}

function ensureLangChainTools(config: AssemblyConfig): Record<string, LangChainToolLike> {
  config.langchain ??= {};
  config.langchain.tools ??= {};

  return config.langchain.tools;
}

async function registerLangChainHandler(
  config: AssemblyConfig,
  client: GatewayClient,
  frameworks: readonly string[]
): Promise<AssemblyCallbackHandler | undefined> {
  if (!frameworks.includes("langchain-js") && !config.langchain) {
    return undefined;
  }

  // Lazy-load the LangChain adapter only on the langchain code path so importing
  // the SDK (and using withAssembly) never pulls in the optional @langchain/core.
  const { AssemblyCallbackHandler } = await import("../adapters/langchain/index.js");
  const callbacks = ensureLangChainCallbacks(config);
  const handler = new AssemblyCallbackHandler(client);
  callbacks.push(handler);
  return handler;
}

async function wrapLangChainTools(
  config: AssemblyConfig,
  client: GatewayClient,
  frameworks: readonly string[]
): Promise<string[]> {
  if (!frameworks.includes("langchain-js") && !config.langchain) {
    return [];
  }

  const { wrapToolWithAssembly } = await import("../adapters/langchain/index.js");
  const tools = ensureLangChainTools(config);
  const wrapperOptions: WrapToolWithAssemblyOptions = {
    ...(config.langchain?.approvalTimeoutMs
      ? { approvalTimeoutMs: config.langchain.approvalTimeoutMs }
      : {})
  };

  for (const tool of Object.values(tools)) {
    wrapToolWithAssembly(tool, client, wrapperOptions);
  }

  return Object.keys(tools);
}

async function patchDetectedVercelAiSdk(
  client: GatewayClient,
  frameworks: readonly string[],
  agentId?: string
): Promise<boolean> {
  if (!frameworks.includes("vercel-ai-sdk")) {
    return false;
  }

  return patchVercelAiSdk({
    gatewayClient: client,
    ...(agentId !== undefined ? { agentId } : {})
  });
}

async function patchDetectedLangGraph(
  frameworks: readonly string[],
  agentId?: string
): Promise<boolean> {
  if (!frameworks.includes("langgraph-js") || !agentId) {
    return false;
  }

  return patchLangGraph({ agentId });
}

async function patchDetectedMastra(
  frameworks: readonly string[],
  agentId?: string
): Promise<boolean> {
  if (!frameworks.includes("mastra") || !agentId) {
    return false;
  }

  return patchMastra({ agentId });
}

async function patchDetectedOpenAIAgents(
  client: GatewayClient,
  frameworks: readonly string[]
): Promise<boolean> {
  if (!frameworks.includes("openai-agents")) {
    return false;
  }

  return patchOpenAIAgents({ gatewayClient: client });
}

/**
 * Validate caller-supplied `initAssembly` config, throwing `RangeError` on the
 * two fields that can arrive malformed from non-TS callers (plain JS, JSON
 * config, dynamic input). Extracted to keep `initAssembly` below the cognitive
 * complexity threshold; behaviour-preserving.
 */
function validateConfig(config: AssemblyConfig): void {
  if (config.delegationReason !== undefined && config.delegationReason.length > 256) {
    throw new RangeError("delegationReason must be <= 256 characters");
  }
  // AAASM-1561: catch invalid enforcementMode strings from non-TS callers
  // (plain JS, JSON config, dynamic input) so the agent doesn't silently
  // register under live enforcement when the operator meant observe.
  if (config.enforcementMode !== undefined && !ENFORCEMENT_MODES.includes(config.enforcementMode)) {
    throw new RangeError(
      `enforcementMode must be one of: ${ENFORCEMENT_MODES.join(", ")} (got: ${String(config.enforcementMode)})`
    );
  }
}

/** Outcome of running every framework patch/detect path during `initAssembly`. */
interface FrameworkPatchResult {
  langChainHandler: AssemblyCallbackHandler | undefined;
  wrappedLangChainTools: string[];
  vercelAiSdkPatched: boolean;
  openAIAgentsPatched: boolean;
  langGraphPatched: boolean;
  mastraPatched: boolean;
}

/**
 * Run every framework detect-and-patch path for the resolved config. Extracted
 * from `initAssembly` to keep its cognitive complexity below threshold;
 * behaviour-preserving (same calls, same order).
 */
async function applyFrameworkPatches(
  config: AssemblyConfig,
  client: GatewayClient,
  frameworks: readonly string[]
): Promise<FrameworkPatchResult> {
  const langChainHandler = await registerLangChainHandler(config, client, frameworks);
  const wrappedLangChainTools = await wrapLangChainTools(config, client, frameworks);
  const vercelAiSdkPatched = await patchDetectedVercelAiSdk(client, frameworks, config.agentId);
  const openAIAgentsPatched = await patchDetectedOpenAIAgents(client, frameworks);
  const langGraphPatched = await patchDetectedLangGraph(frameworks, config.agentId);
  const mastraPatched = await patchDetectedMastra(frameworks, config.agentId);

  return {
    langChainHandler,
    wrappedLangChainTools,
    vercelAiSdkPatched,
    openAIAgentsPatched,
    langGraphPatched,
    mastraPatched
  };
}

/**
 * Build the deduped list of active adapter ids from the registered adapters plus
 * whichever framework patches actually took effect. Extracted from
 * `initAssembly` to keep its cognitive complexity below threshold.
 */
function buildActiveAdapters(adapters: readonly Adapter[], patches: FrameworkPatchResult): string[] {
  return [
    ...new Set([
      ...adapters.map((adapter) => adapter.id),
      ...(patches.langChainHandler ? ["langchain-js"] : []),
      ...(patches.wrappedLangChainTools.length > 0 ? ["langchain-js"] : []),
      ...(patches.vercelAiSdkPatched ? ["vercel-ai-sdk"] : []),
      ...(patches.openAIAgentsPatched ? ["openai-agents"] : []),
      ...(patches.langGraphPatched ? ["langgraph-js"] : []),
      ...(patches.mastraPatched ? ["mastra"] : [])
    ])
  ];
}

export async function initAssembly(config: AssemblyConfig = {}): Promise<AssemblyContext> {
  validateConfig(config);
  // Auto-populate parentAgentId from the async context store when not explicitly provided.
  // This allows child agents spawned inside framework hooks to inherit lineage automatically.
  const resolvedParentAgentId = config.parentAgentId ?? currentAgentId();
  // Env-var fallbacks read at entry: explicit config field > env-var > the
  // downstream resolver chain (which may itself error if required and absent).
  const gatewayUrlInput = config.gatewayUrl ?? process.env[ENV_GATEWAY_URL];
  const controlPlaneUrlInput = config.controlPlaneUrl ?? process.env[ENV_CONTROL_PLANE_URL];
  const resolvedGatewayUrl = await resolveGatewayUrl(gatewayUrlInput);
  const resolvedApiKey = await resolveApiKey(config.apiKey);
  const resolvedConfig: AssemblyConfig = {
    ...config,
    gatewayUrl: resolvedGatewayUrl,
    apiKey: resolvedApiKey,
    ...(controlPlaneUrlInput !== undefined ? { controlPlaneUrl: controlPlaneUrlInput } : {}),
    ...(resolvedParentAgentId ? { parentAgentId: resolvedParentAgentId } : {})
  };

  const client = createClient(resolvedConfig);
  const frameworks = detectFrameworks();
  const adapters = await registerAdapters(frameworks);

  await startNetworkLayerIfNeeded(client, resolvedConfig);

  // Send topology registration event through the native transport on every boot
  // except sdk-only mode (which has no sidecar to register with).
  let nativeClient: NativeClient | undefined;
  if (resolvedConfig.mode !== "sdk-only") {
    nativeClient = createNativeClient({
      gateway: resolvedGatewayUrl,
      apiKey: resolvedApiKey,
      mode: resolvedConfig.mode === "napi-inprocess" ? "napi-inprocess" : "grpc-sidecar"
    });
    nativeClient.sendEvent(buildRegistrationEvent(resolvedConfig));
  }

  const patches = await applyFrameworkPatches(resolvedConfig, client, frameworks);

  return {
    activeAdapters: buildActiveAdapters(adapters, patches),
    ...(resolvedConfig.parentAgentId !== undefined && {
      parentAgentId: resolvedConfig.parentAgentId
    }),
    ...(resolvedConfig.teamId !== undefined && { teamId: resolvedConfig.teamId }),
    ...(resolvedConfig.delegationReason !== undefined && {
      delegationReason: resolvedConfig.delegationReason
    }),
    ...(resolvedConfig.spawnedByTool !== undefined && {
      spawnedByTool: resolvedConfig.spawnedByTool
    }),
    ...(resolvedConfig.enforcementMode !== undefined && {
      enforcementMode: resolvedConfig.enforcementMode
    }),
    shutdown: async () => {
      for (const adapter of adapters) {
        await adapter.shutdown?.();
      }
      await nativeClient?.close();
      await client.close();
    }
  };
}
