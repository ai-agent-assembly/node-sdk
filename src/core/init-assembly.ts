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
import {
  createNativeClient,
  type NativeClient,
  type RegisterOptions
} from "../native/client.js";
import { ConfigurationError } from "../errors/index.js";
import type { AssemblyConfig } from "../types/assembly-config.js";
import type { AssemblyContext } from "../types/assembly-context.js";
import type { AssemblyMode } from "../types/assembly-mode.js";
import { ENFORCEMENT_MODES, resolveFailClosed } from "../types/enforcement-mode.js";
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
import { redactErrorMessage } from "./redact.js";

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

/**
 * Build the {@link RegisterOptions} for the native `register` gRPC call
 * (AAASM-3400) from the resolved config and the detected frameworks. `name`
 * falls back to `agentId`; `framework` is the first detected framework (or
 * `"none"` when running without an adapter); `gatewayEndpoint` is set only when
 * a gateway URL was resolved so the native default endpoint resolution is
 * preserved when it was not. `teamId` / `parentAgentId` carry the agent's
 * team-budget scoping and topology lineage to the gateway (AAASM-3415); each is
 * set only when present so an unset field stays absent.
 */
function buildRegisterOptions(
  config: AssemblyConfig,
  frameworks: readonly string[]
): RegisterOptions {
  const agentId = config.agentId ?? "";
  return {
    agentId,
    name: config.name ?? agentId,
    framework: frameworks[0] ?? "none",
    ...(config.gatewayUrl ? { gatewayEndpoint: config.gatewayUrl } : {}),
    ...(config.teamId ? { teamId: config.teamId } : {}),
    ...(config.parentAgentId ? { parentAgentId: config.parentAgentId } : {})
  };
}

/**
 * The only built-in {@link AssemblyMode} for which {@link createClient}
 * constructs a gateway client whose `check()` consults a real authoritative
 * verdict (the native `queryPolicy` against a reachable `aa-runtime`). Every
 * other mode falls back to the allow-all no-op client.
 */
const CHECK_CAPABLE_MODE: AssemblyMode = "napi-inprocess";

export function createClient(
  config: AssemblyConfig,
  nativeClientOverride?: NativeClient
): GatewayClient {
  const mode = config.mode ?? "auto";
  if (config.gatewayClient) {
    return config.gatewayClient;
  }

  // AAASM-3105 (fail closed): the no-op gateway client's `check()` is allow-all,
  // so registering under live `"enforce"` while routing through it would let a
  // policy-denied action proceed unchecked — a silent fail-open. When the caller
  // explicitly asks for `"enforce"` but supplies no check-capable mode (and no
  // own `gatewayClient`), refuse loudly instead of pretending to enforce. An
  // omitted `enforcementMode` keeps the pre-feature behavior (server-side
  // default), and `"observe"` / `"disabled"` intentionally let actions through.
  if (config.enforcementMode === "enforce" && mode !== CHECK_CAPABLE_MODE) {
    throw new ConfigurationError(
      `enforcementMode "enforce" requires a check-capable client, but mode "${mode}" ` +
        `routes through the allow-all no-op gateway client, which cannot block a ` +
        `denied action. Use mode "${CHECK_CAPABLE_MODE}", supply your own ` +
        `gatewayClient, or set enforcementMode to "observe"/"disabled".`
    );
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
    // Reuse the caller-supplied native client when present so the registered
    // session (the one `register()` stored the gateway token on) is the same
    // session `queryPolicy` runs against. Standalone callers (and the routing
    // tests) get a freshly-built client instead.
    const nativeClient =
      nativeClientOverride ??
      createNativeClient({
        gateway: config.gatewayUrl ?? "",
        apiKey: config.apiKey ?? "",
        mode: "napi-inprocess",
        // AAASM-4013: under enforce, a runtime that returns no authoritative
        // verdict (fail-open sentinel / unknown decision) must deny, not allow.
        // AAASM-4172: an omitted posture defaults to enforce (py/go parity).
        failClosed: resolveFailClosed(config.enforcementMode)
      });
    return createNativeGatewayClient(mode, nativeClient, config.agentId, httpBaseUrl, config.enforcementMode);
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
    ...(agentId === undefined ? {} : { agentId })
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
    ...(controlPlaneUrlInput === undefined ? {} : { controlPlaneUrl: controlPlaneUrlInput }),
    ...(resolvedParentAgentId ? { parentAgentId: resolvedParentAgentId } : {})
  };

  const frameworks = detectFrameworks();

  // Build the native transport up front (every mode except sdk-only, which has
  // no sidecar) so the same session backs both the gateway client's `check()`
  // and the agent registration — the gateway token `register()` stores on the
  // session is then attached to every subsequent `queryPolicy` request.
  let nativeClient: NativeClient | undefined;
  if (resolvedConfig.mode !== "sdk-only") {
    nativeClient = createNativeClient({
      gateway: resolvedGatewayUrl,
      apiKey: resolvedApiKey,
      mode: resolvedConfig.mode === "napi-inprocess" ? "napi-inprocess" : "grpc-sidecar",
      // AAASM-4013: under enforce, a runtime that returns no authoritative
      // verdict (fail-open sentinel / unknown decision) must deny, not allow.
      // AAASM-4172: an omitted posture defaults to enforce (py/go parity).
      failClosed: resolveFailClosed(resolvedConfig.enforcementMode)
    });
  }

  const client = createClient(resolvedConfig, nativeClient);
  const adapters = await registerAdapters(frameworks);

  await startNetworkLayerIfNeeded(client, resolvedConfig);

  if (nativeClient !== undefined) {
    // AAASM-3403: register the agent over the native SDK→gateway gRPC call so
    // the gateway issues a credential token (stored on this session) that
    // unblocks subsequent policy queries. Advisory: a failed registration must
    // not abort init — the agent proceeds unregistered and the proxy / eBPF
    // layers remain authoritative.
    try {
      await nativeClient.register(buildRegisterOptions(resolvedConfig, frameworks));
    } catch (error) {
      // Redact any Bearer/auth credential the error message might carry before
      // it reaches the console — the apiKey/credentialToken must never be logged
      // (AAASM-3645).
      console.warn(
        `[agent-assembly] agent registration failed; proceeding unregistered: ${redactErrorMessage(error)}`
      );
    }
    // Topology lineage metadata still flows as an audit event (parent / team /
    // delegation), which `register` does not carry.
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
