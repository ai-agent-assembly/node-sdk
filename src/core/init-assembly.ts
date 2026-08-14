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
  NativeSendEventError,
  type NativeClient,
  type RegisterOptions
} from "../native/client.js";
import { ConfigurationError } from "../errors/index.js";
import type { AssemblyConfig } from "../types/assembly-config.js";
import type { AssemblyContext } from "../types/assembly-context.js";
import type { AssemblyMode } from "../types/assembly-mode.js";
import type { AuditSinkDisposition } from "../types/gateway-governance.js";
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
 * `"none"` when running without an adapter). `teamId` / `parentAgentId` carry
 * the agent's team-budget scoping and topology lineage to the gateway
 * (AAASM-3415); each is set only when present so an unset field stays absent.
 *
 * `gatewayEndpoint` is deliberately left **unset** so `aa-sdk-client` applies
 * its default gRPC lifecycle endpoint (`127.0.0.1:50051`). `config.gatewayUrl`
 * is the SDK's HTTP base (`:7391` / `:8080`), which is *not* a valid gRPC
 * register endpoint — passing it here pointed registration at the wrong
 * protocol/port (AAASM-4468). Callers that need a non-default gRPC endpoint set
 * it out-of-band via `AA_GATEWAY_ENDPOINT`.
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
    ...(config.teamId ? { teamId: config.teamId } : {}),
    ...(config.parentAgentId ? { parentAgentId: config.parentAgentId } : {})
  };
}

/**
 * Resolve what the client in use does with hook-layer audit events, for the
 * `auditSink` field on the returned context (AAASM-5681).
 *
 * An omitted `auditSink` means the client did not come from this package, so
 * the honest answer is `"caller-supplied"` — the absence of a claim, not an
 * assurance. Both shipped clients declare a disposition explicitly; the native
 * one computes it from whether the binding loaded (AAASM-5750).
 */
function resolveAuditSink(client: GatewayClient): AuditSinkDisposition {
  return client.auditSink ?? "caller-supplied";
}

/**
 * Tell the caller, once per `initAssembly`, that governed actions will produce
 * no audit evidence (AAASM-5681).
 *
 * Before this, the only signal was a one-shot note gated on `AA_DEBUG=1` — so a
 * caller had to already suspect the problem in order to discover it. Enforcement
 * is genuinely unaffected, which is exactly why the drop is easy to miss: denies
 * still deny, and every audit call resolves successfully.
 *
 * Since AAASM-5750 a native client over a loaded binding forwards the events, so
 * this fires only for the clients that still hold no channel: the no-op client,
 * and a native client built over the fallback stub.
 *
 * Written straight to `process.stderr` rather than `console`/a swappable logger,
 * and at init rather than per audit call, for the same reasons as
 * {@link warnAgentUnregistered}: it cannot be silenced by log configuration and
 * it cannot become steady-state noise. It does not fail init — a caller may not
 * need SDK-side audit at all, and the proxy / eBPF layers are unaffected.
 */
function warnAuditEventsDiscarded(mode: AssemblyMode | "auto"): void {
  // The enforcement clause MUST branch on the mode. This warning fires for both
  // shipped clients, and they differ on exactly this point: in
  // CHECK_CAPABLE_MODE `createClient` returns the native client, whose `check()`
  // routes to the runtime and can genuinely deny; in every other mode it returns
  // the allow-all no-op. A single unconditional sentence is wrong in one
  // direction or the other, which it has been twice (AAASM-5681).
  const enforcementClause =
    mode === CHECK_CAPABLE_MODE
      ? `This does not change the enforcement posture: policy checks in ` +
        `"${mode}" route through the native runtime, not the allow-all no-op ` +
        `client, so a policy DENY can still block a tool. `
      : `This does not change the enforcement posture — but note that ` +
        `"${mode}" routes policy checks through the allow-all no-op client, so ` +
        `a policy DENY does not block a tool call in this mode either way. `;
  process.stderr.write(
    `[agent-assembly] WARNING: hook-layer audit events are DISCARDED in ` +
      `"${mode}" mode: the gateway client resolved here holds no native event ` +
      `channel, so record / recordResult / scanPrompts have nowhere to send to, ` +
      `governed actions produce NO audit evidence, and nothing on this path can ` +
      `be attributed or reviewed after the fact. ${enforcementClause}` +
      `Run with a loaded native binding so the events reach the runtime, or ` +
      `supply your own "gatewayClient". Inspect the "auditSink" field on the ` +
      `returned assembly context to detect this programmatically (AAASM-5681, ` +
      `AAASM-5750).\n`
  );
}

/**
 * Emit a prominent, unconditional stderr warning that the agent was **not**
 * registered with the gateway by this SDK (AAASM-4468).
 *
 * Fires only when the native `aa-sdk-client` binding could not be loaded and the
 * transport fell back to the no-op stub (unsupported platform such as Windows,
 * or a missing native binary). That stub's `register` resolves to `""` — a
 * success-shaped value — so `initAssembly` would otherwise report a clean init
 * for an agent that never registered and will never appear in the dashboard /
 * `/api/v1/agents`. A governance SDK must never emit a false clean-init signal
 * when registration structurally did not happen, so we say so loudly. Written
 * straight to `process.stderr` (not `console`/a swappable logger) so it cannot
 * be silenced by log configuration, and once per `initAssembly` call — at init,
 * not per policy query.
 *
 * This does not fail init: an external sidecar may still register the agent
 * out-of-band, so the honest posture is "warn + surface, don't break".
 *
 * On Windows the binding is *never* present (the governance core is Unix-only
 * and no win32 `.node` is built), so the generic "could not be loaded" wording
 * reads as a transient/missing-binary fault the user might try to fix. We give
 * win32 an honest platform-specific message instead — Windows is not supported
 * yet — while keeping the same "unregistered / not in the dashboard" consequence
 * and the `registered`-flag pointer.
 */
function warnAgentUnregistered(mode: AssemblyMode | "auto"): void {
  if (process.platform === "win32") {
    process.stderr.write(
      `[agent-assembly] WARNING: Windows is not supported yet — the governance ` +
        `core is Unix-only, so no native aa-sdk-client binding is built for ` +
        `Windows. The SDK's JS API still works, but the agent is NOT registered ` +
        `with the governance gateway in "${mode}" mode and will NOT appear in the ` +
        `dashboard or GET /api/v1/agents unless an external sidecar registers it ` +
        `out-of-band. Inspect the "registered" flag on the returned assembly ` +
        `context to detect this programmatically.\n`
    );
    return;
  }
  process.stderr.write(
    `[agent-assembly] WARNING: the agent is NOT registered with the governance ` +
      `gateway in "${mode}" mode: the native aa-sdk-client binding could not be ` +
      `loaded (unsupported platform or missing native binary), so this SDK cannot ` +
      `perform gateway registration. The agent will NOT appear in the dashboard ` +
      `or GET /api/v1/agents unless an external sidecar registers it out-of-band. ` +
      `Inspect the "registered" flag on the returned assembly context to detect ` +
      `this programmatically.\n`
  );
}

/**
 * The only built-in {@link AssemblyMode} for which {@link createClient}
 * constructs a gateway client whose `check()` consults a real authoritative
 * verdict (the native `queryPolicy` against a reachable `aa-runtime`). Every
 * other mode falls back to the allow-all no-op client.
 */
const CHECK_CAPABLE_MODE: AssemblyMode = "napi-inprocess";

/**
 * Whether this `initAssembly` call passes explicit LangChain tools to be wrapped
 * in place. Each wrapped tool's `invoke()` is gated by the gateway client's
 * `check()` (see {@link wrapLangChainTools}), so when the resolved mode is not
 * {@link CHECK_CAPABLE_MODE} — where `check()` is the allow-all no-op
 * (`createNoopGatewayClient`) — a policy DENY would be silently allowed. This is
 * the concrete, documented (04-guides LangChain quick-start) vector for the
 * AAASM-4735 fail-open and the trigger for the guard in {@link initAssembly}.
 *
 * Deliberately scoped to explicit `langchain.tools`, NOT to auto-detected
 * frameworks: a registration-/telemetry-only `initAssembly()` in an app that
 * merely has `@langchain/core` / `ai` / `@openai/agents` on its dependency tree
 * must keep its intended allow-all no-op client (AAASM-1847 / 3050 / 3105), and
 * a bare install of those packages is indistinguishable from real use at init
 * time.
 */
function wrapsToolsThroughGatewayClient(config: AssemblyConfig): boolean {
  const tools = config.langchain?.tools;
  return tools !== undefined && Object.keys(tools).length > 0;
}

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
    return createNativeGatewayClient(
      mode,
      nativeClient,
      config.agentId,
      httpBaseUrl,
      config.enforcementMode
    );
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

/**
 * ⚠️ Both `ensure*` helpers below run against the SHALLOW COPY `initAssembly` makes of
 * the caller's config, so the `??=` is a footgun: when the caller supplied `langchain`
 * that nested object is shared by reference and a mutation is visible to them, but when
 * they did not, `??=` mints a fresh object on the copy and everything written into it is
 * discarded the moment `initAssembly` returns. Crediting such a write as a successful
 * patch is what made `activeAdapters` report `langchain-js` for a run governing nothing
 * (AAASM-5664).
 *
 * Their two callers therefore check `config.langchain !== undefined` FIRST and bail —
 * see the reachability guards in {@link registerLangChainHandler} and
 * {@link wrapLangChainTools}. Do not call these helpers from a new site without the
 * same guard, and do not "simplify" the guards away: nothing in the type system stops
 * the `??=` from silently re-arming this.
 */
function ensureLangChainCallbacks(config: AssemblyConfig): LangChainCallbackHandlerLike[] {
  config.langchain ??= {};
  config.langchain.callbacks ??= [];

  return config.langchain.callbacks;
}

/** See the reachability warning on {@link ensureLangChainCallbacks}. */
function ensureLangChainTools(config: AssemblyConfig): Record<string, LangChainToolLike> {
  config.langchain ??= {};
  config.langchain.tools ??= {};

  return config.langchain.tools;
}

/**
 * One-time advisory that `@langchain/core` was found but nothing was wired.
 *
 * The sibling auto-detected frameworks (Vercel AI SDK, LangGraph, Mastra) all warn
 * on stderr when their patch cannot deliver governance. LangChain had no equivalent
 * signal for the detected-but-unwired case, so the only evidence was an
 * `activeAdapters` entry that claimed the opposite (AAASM-5664). Written straight to
 * `process.stderr`, like its siblings, so log configuration cannot silence it.
 */
function warnLangChainDetectedButUnwired(): void {
  process.stderr.write(
    `[agent-assembly] WARNING: "@langchain/core" is installed but no \`langchain\` ` +
      `config was supplied to initAssembly, so this SDK has nothing to attach to and ` +
      `LangChain activity will NOT be observed or governed. Unlike the other ` +
      `auto-detected frameworks, LangChain cannot be patched globally — the callback ` +
      `handler has to be reachable from your chain. Pass \`langchain: { callbacks: [...] }\` ` +
      `(and \`tools\` for in-process tool governance) so the handler lands in an object ` +
      `you own. Reported in \`unpatchedAdapters\`, never \`activeAdapters\` (AAASM-5664).\n`
  );
}

async function registerLangChainHandler(
  config: AssemblyConfig,
  client: GatewayClient,
  frameworks: readonly string[]
): Promise<AssemblyCallbackHandler | undefined> {
  // Reachability, not mere presence. `initAssembly` patches a SHALLOW copy of the
  // caller's config, so `config.langchain` is shared by reference only when the
  // caller supplied it. Read it before `ensureLangChainCallbacks` can mint one.
  const callerSuppliedLangChain = config.langchain !== undefined;

  if (!frameworks.includes("langchain-js") && !callerSuppliedLangChain) {
    return undefined;
  }

  // AAASM-5664: with `@langchain/core` merely detected and no `langchain` config,
  // the `??=` in `ensureLangChainCallbacks` mints a fresh object on the COPY, so the
  // handler is pushed into an array the caller can never read and is discarded when
  // `initAssembly` returns. `AssemblyCallbackHandler`'s constructor only calls
  // `super()` — there is no global callback-manager registration that could rescue
  // it. Registering here would therefore be a no-op that still reported
  // `langchain-js` as an active adapter: precisely the false success this ticket
  // exists to remove. Decline, and say so on stderr.
  if (!callerSuppliedLangChain) {
    warnLangChainDetectedButUnwired();
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
  client: GatewayClient
): Promise<string[]> {
  // Only the caller's own `langchain.tools` can be wrapped: `wrapToolWithAssembly`
  // mutates the tool objects in place, so a map minted by `ensureLangChainTools` on
  // the shallow copy has nothing in it and nothing the caller could invoke. Detection
  // alone therefore cannot wrap anything (AAASM-5664) — the old condition returned an
  // empty list here anyway, but only after pointlessly importing the optional
  // LangChain adapter. Mirrors the reachability guard in `registerLangChainHandler`.
  if (config.langchain === undefined) {
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
  config: AssemblyConfig,
  client: GatewayClient,
  frameworks: readonly string[],
  agentId?: string
): Promise<boolean> {
  if (!frameworks.includes("vercel-ai-sdk")) {
    return false;
  }

  // When in-process Vercel governance would be inert, `patchVercelAiSdk` warns
  // loudly and returns false, so this auto-detected path never surfaces
  // `vercelAiSdkPatched` / an active adapter for an ungoverned Vercel install. Two
  // inert shapes, handled differently on purpose:
  //  - AAASM-4805 (moved hook): `ai` installed but the `tool` export is gone. Rare
  //    broken/pinned state, so under a fail-closed posture it THROWS (`failClosed`).
  //  - AAASM-4842 (frozen namespace): a real `ai` ES module can't have the governed
  //    factory written back. This is the shape of EVERY real `ai`, so we do NOT
  //    thread `throwOnFrozenInert` here — hard-failing init on mere presence of `ai`
  //    would regress zero-config (AAASM-1847) and the auto-detected warn-not-throw
  //    invariant (AAASM-4769). It warns and is excluded from the active adapters.
  return patchVercelAiSdk({
    gatewayClient: client,
    failClosed: resolveFailClosed(config.enforcementMode),
    ...(agentId === undefined ? {} : { agentId })
  });
}

async function patchDetectedLangGraph(
  config: AssemblyConfig,
  frameworks: readonly string[],
  agentId?: string
): Promise<boolean> {
  if (!frameworks.includes("langgraph-js") || !agentId) {
    return false;
  }

  // AAASM-4830: LangGraph is lineage-only (NON_ENFORCING_MODULES) — passing the
  // resolved posture lets the hook emit a one-time note under enforce so an
  // operator isn't misled that in-process tool governance is in effect.
  return patchLangGraph({ agentId, failClosed: resolveFailClosed(config.enforcementMode) });
}

async function patchDetectedMastra(
  config: AssemblyConfig,
  frameworks: readonly string[],
  agentId?: string
): Promise<boolean> {
  if (!frameworks.includes("mastra") || !agentId) {
    return false;
  }

  // AAASM-4830: Mastra is lineage-only (NON_ENFORCING_MODULES) — passing the
  // resolved posture lets the hook emit a one-time note under enforce so an
  // operator isn't misled that in-process tool governance is in effect.
  return patchMastra({ agentId, failClosed: resolveFailClosed(config.enforcementMode) });
}

async function patchDetectedOpenAIAgents(
  config: AssemblyConfig,
  client: GatewayClient,
  frameworks: readonly string[]
): Promise<boolean> {
  if (!frameworks.includes("openai-agents")) {
    return false;
  }

  // AAASM-4797: when the upstream @openai/agents tool-execution API has moved
  // past every hook point we know, `patchOpenAIAgents` warns loudly and — under
  // a fail-closed (enforce) posture — throws rather than register ungoverned.
  return patchOpenAIAgents({
    gatewayClient: client,
    failClosed: resolveFailClosed(config.enforcementMode)
  });
}

/**
 * Whether an auto-detected-framework patch (Vercel AI SDK, OpenAI Agents) is
 * about to route its `check()` calls through the allow-all no-op gateway
 * client under a fail-closed posture — the residual AAASM-4735 gap
 * (AAASM-4769). Mirrors the boolean logic of the explicit-tools guard above,
 * minus `wrapsToolsThroughGatewayClient`: auto-detected frameworks have no
 * init-time throw (a bare dependency install must stay zero-config,
 * AAASM-1847), so this only gates whether to warn, never whether to fail.
 */
function autoDetectedToolsRouteThroughNoop(config: AssemblyConfig): boolean {
  const mode = config.mode ?? "auto";
  return (
    mode !== CHECK_CAPABLE_MODE &&
    config.gatewayClient === undefined &&
    resolveFailClosed(config.enforcementMode)
  );
}

/**
 * One-time (per `initAssembly` call) advisory warning for the gap
 * {@link autoDetectedToolsRouteThroughNoop} detects: unlike explicit
 * `langchain.tools`, auto-detected frameworks are patched without a guard
 * that can hard-fail at init, so a fail-closed posture routed through the
 * no-op client would otherwise silently let a policy DENY through with no
 * signal at all. Written straight to `process.stderr` (not a swappable
 * logger) so it can't be silenced by log configuration. Called once from
 * {@link applyFrameworkPatches} after every auto-detect patch has run, so
 * installing multiple auto-detected frameworks in the same `initAssembly`
 * call still emits exactly one warning, not one per framework.
 */
function warnAutoDetectedToolsRouteThroughNoop(
  patchedFrameworks: readonly string[],
  mode: AssemblyMode | "auto"
): void {
  if (patchedFrameworks.length === 0) {
    return;
  }
  process.stderr.write(
    `[agent-assembly] WARNING: auto-detected framework(s) ${patchedFrameworks.join(", ")} ` +
      `were patched for in-process tool governance, but mode "${mode}" routes tool policy ` +
      `checks through the allow-all no-op gateway client — a policy DENY will NOT block a ` +
      `tool call. In-process tool governance for an auto-detected framework requires mode ` +
      `"${CHECK_CAPABLE_MODE}" (or supplying your own gatewayClient); otherwise tool checks ` +
      `route through the allow-all no-op client. This is advisory only: unlike explicit ` +
      `langchain.tools, auto-detected frameworks cannot hard-fail at init without breaking ` +
      `zero-config for a bare dependency install (AAASM-1847).\n`
  );
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
 * Run every framework detect-and-patch path for the resolved config, then emit
 * the AAASM-4769 no-op-enforcement warning (see
 * {@link warnAutoDetectedToolsRouteThroughNoop}) if applicable. Extracted from
 * `initAssembly` to keep its cognitive complexity below threshold.
 */
async function applyFrameworkPatches(
  config: AssemblyConfig,
  client: GatewayClient,
  frameworks: readonly string[]
): Promise<FrameworkPatchResult> {
  const langChainHandler = await registerLangChainHandler(config, client, frameworks);
  const wrappedLangChainTools = await wrapLangChainTools(config, client);
  const vercelAiSdkPatched = await patchDetectedVercelAiSdk(config, client, frameworks, config.agentId);
  const openAIAgentsPatched = await patchDetectedOpenAIAgents(config, client, frameworks);
  const langGraphPatched = await patchDetectedLangGraph(config, frameworks, config.agentId);
  const mastraPatched = await patchDetectedMastra(config, frameworks, config.agentId);

  if (autoDetectedToolsRouteThroughNoop(config)) {
    warnAutoDetectedToolsRouteThroughNoop(
      [
        ...(vercelAiSdkPatched ? ["vercel-ai-sdk"] : []),
        ...(openAIAgentsPatched ? ["openai-agents"] : [])
      ],
      config.mode ?? "auto"
    );
  }

  return {
    langChainHandler,
    wrappedLangChainTools,
    vercelAiSdkPatched,
    openAIAgentsPatched,
    langGraphPatched,
    mastraPatched
  };
}

/** The three distinct adapter states `initAssembly` can observe for a run. */
interface AdapterStates {
  /** Frameworks found installed in the environment, patched or not. */
  detected: string[];
  /**
   * Frameworks whose patch was applied and is reachable by the caller. NOT an
   * enforcement claim — LangGraph and Mastra are lineage-only, the LangChain
   * callback layer is audit-only, and every enforcing path degrades to a
   * non-blocking check under the allow-all no-op client. See the
   * `AssemblyContext.activeAdapters` TSDoc for the per-framework breakdown.
   */
  active: string[];
  /** Detected frameworks whose patch did not take effect (failed, inert, skipped, or unreachable). */
  unpatched: string[];
}

/**
 * Ids of the frameworks whose patch actually took effect this run.
 *
 * Deliberately derived from the patch *results* alone. The previous
 * implementation unioned these with the detection list, and since every
 * non-LangChain patch here is itself gated on detection, the union could only
 * ever reproduce the detection list — a framework found on disk was reported
 * active even when its patch had just warned that it was inert (AAASM-5664).
 *
 * LangChain is the one id that can be active without being detected: an
 * explicit `config.langchain` wraps callbacks/tools through the gateway client
 * whether or not `@langchain/core` resolves, so its two flags are the only
 * genuinely load-bearing half of the old union and are preserved here.
 */
function patchedAdapterIds(patches: FrameworkPatchResult): Set<string> {
  return new Set([
    ...(patches.langChainHandler ? ["langchain-js"] : []),
    ...(patches.wrappedLangChainTools.length > 0 ? ["langchain-js"] : []),
    ...(patches.vercelAiSdkPatched ? ["vercel-ai-sdk"] : []),
    ...(patches.openAIAgentsPatched ? ["openai-agents"] : []),
    ...(patches.langGraphPatched ? ["langgraph-js"] : []),
    ...(patches.mastraPatched ? ["mastra"] : [])
  ]);
}

/**
 * Split the run's frameworks into detected / active / unpatched.
 *
 * Kept as three explicit lists rather than one filtered array because callers
 * genuinely need to tell them apart: "the framework is not installed" and "the
 * framework is installed but this SDK is not governing it" are different facts
 * with different remedies, and collapsing them into a single `activeAdapters`
 * omission would trade one misleading signal for another.
 */
function buildAdapterStates(
  adapters: readonly Adapter[],
  patches: FrameworkPatchResult
): AdapterStates {
  const detected = [...new Set(adapters.map((adapter) => adapter.id))];
  const patched = patchedAdapterIds(patches);

  // Detection order first so the common case keeps a stable, predictable
  // ordering, then any patched id that was never detected (the explicit
  // `config.langchain` path).
  const active = [
    ...detected.filter((id) => patched.has(id)),
    ...[...patched].filter((id) => !detected.includes(id))
  ];

  return {
    detected,
    active,
    unpatched: detected.filter((id) => !patched.has(id))
  };
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

  // AAASM-4735 (fail closed for wrapped tools): explicit LangChain tools are
  // wrapped so each `invoke()` is gated by the gateway client's `check()`. In a
  // non-check-capable mode that client is the allow-all no-op, so a tool DENY
  // would be silently allowed — the fail-open this guard closes. `resolveFailClosed`
  // treats an OMITTED enforcementMode as enforce (py/go parity, AAASM-4172), so a
  // caller who wraps tools expecting enforcement without naming a posture must
  // fail loud rather than register under a no-op check. Explicit `observe` /
  // `disabled` opt out (advisory by design) and a caller-supplied `gatewayClient`
  // owns its own `check()`; registration-/telemetry-only inits (no wrapped tools)
  // keep the intended no-op client, so zero-config `initAssembly()` and sdk-only
  // stay working (AAASM-1847 / 3050 / 3105).
  const resolvedMode = resolvedConfig.mode ?? "auto";
  if (
    resolveFailClosed(resolvedConfig.enforcementMode) &&
    resolvedMode !== CHECK_CAPABLE_MODE &&
    resolvedConfig.gatewayClient === undefined &&
    wrapsToolsThroughGatewayClient(resolvedConfig)
  ) {
    throw new ConfigurationError(
      `in-process tool enforcement requires a check-capable client, but mode ` +
        `"${resolvedMode}" routes tool policy checks through the allow-all no-op ` +
        `gateway client, which cannot block a denied tool call. LangChain tools ` +
        `are being wrapped under a fail-closed posture (enforcementMode ` +
        `${resolvedConfig.enforcementMode === undefined ? '"enforce" by default' : `"${resolvedConfig.enforcementMode}"`}). ` +
        `Use mode "${CHECK_CAPABLE_MODE}", supply your own gatewayClient, or set ` +
        `enforcementMode to "observe"/"disabled".`
    );
  }

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

  // Whether this SDK actually registered the agent with the gateway. Surfaced on
  // the returned context (AAASM-4468) so callers can detect the unregistered
  // state programmatically, not only via the stderr warning below.
  let registered = false;
  if (nativeClient !== undefined) {
    if (nativeClient.canRegister) {
      // AAASM-3403: register the agent over the native SDK→gateway gRPC call so
      // the gateway issues a credential token (stored on this session) that
      // unblocks subsequent policy queries. Advisory: a failed registration must
      // not abort init — the agent proceeds unregistered and the proxy / eBPF
      // layers remain authoritative.
      try {
        await nativeClient.register(buildRegisterOptions(resolvedConfig, frameworks));
        registered = true;
      } catch (error) {
        // Redact any Bearer/auth credential the error message might carry before
        // it reaches the console — the apiKey/credentialToken must never be logged
        // (AAASM-3645).
        console.warn(
          `[agent-assembly] agent registration failed; proceeding unregistered: ${redactErrorMessage(error)}`
        );
      }
    } else {
      // AAASM-4468: the binding could not be loaded, so the transport is the
      // no-op stub whose `register` resolves to a success-shaped `""`. The
      // try/catch above would never fire and init would falsely report success.
      // Fail loud instead: emit the unregistered warning and leave `registered`
      // false.
      warnAgentUnregistered(resolvedConfig.mode ?? "auto");
    }
    // Topology lineage metadata (parent / team / delegation) flows as an audit
    // event that `register` does not itself carry, so it ships even when the
    // agent proceeded unregistered — the lineage graph is independent of
    // registration success. This send is fire-and-forget/advisory; if it fails
    // (e.g. a tolerated register failure left the IPC channel closed) the native
    // client stashes the fault as `pendingSendError`, which the shutdown path
    // below swallows so an advisory event can't reject `shutdown()` (AAASM-4652).
    nativeClient.sendEvent(buildRegistrationEvent(resolvedConfig));
  }

  const patches = await applyFrameworkPatches(resolvedConfig, client, frameworks);
  const adapterStates = buildAdapterStates(adapters, patches);

  // AAASM-5681 — surface a discarding audit sink on the default path. Emitted
  // after patching so it lands once the governed surface is actually in place,
  // and only when this SDK knows the events go nowhere.
  //
  // The condition names the one disposition that warrants it rather than
  // excluding the caller's (AAASM-5750): "forwarded" must not warn, and a future
  // fourth value should have to opt in to this warning rather than inherit it.
  const auditSink = resolveAuditSink(client);
  if (auditSink === "discarded") {
    warnAuditEventsDiscarded(resolvedConfig.mode ?? "auto");
  }

  return {
    activeAdapters: adapterStates.active,
    detectedAdapters: adapterStates.detected,
    unpatchedAdapters: adapterStates.unpatched,
    registered,
    auditSink,
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
      // The topology audit event above is advisory and fire-and-forget: if it
      // failed to enqueue (e.g. a tolerated register failure left the IPC
      // channel closed) the native client stashed the fault and `close()`
      // re-throws it. That internal send must never turn a clean teardown into a
      // `shutdown()` rejection, so swallow-and-log it here (AAASM-4652). The
      // error is redacted before logging (AAASM-3645) and `close()`'s re-throw
      // contract is unchanged for direct callers.
      try {
        await nativeClient?.close();
      } catch (error) {
        // Only the advisory topology-event send failure is safe to swallow:
        // `close()` re-throws it as a `NativeSendEventError` when the
        // fire-and-forget event above could not enqueue (AAASM-4652). Any other
        // fault — notably a genuine `NativeDisconnectError` from tearing down the
        // native session — is a real teardown failure that must surface from
        // `shutdown()`, not be mislabeled as an advisory event error and
        // swallowed (AAASM-4699).
        if (!(error instanceof NativeSendEventError)) {
          throw error;
        }
        console.warn(
          `[agent-assembly] ignoring advisory event error during shutdown: ${redactErrorMessage(error)}`
        );
      }
      await client.close();
    }
  };
}
