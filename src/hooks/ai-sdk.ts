/**
 * Vercel AI SDK governance hook.
 *
 * Installs a governed `tool` factory over the `ai` package so tool executions
 * route a pre-execution allow/deny check through the gateway.
 *
 * The single supported hook point is the `ai` package's `tool` factory export.
 * When `ai` is installed but that export is absent — not a function (a future
 * `ai` major renamed or moved the factory) — the upstream API has moved out from
 * under us. We must NOT silently no-op (the AAASM-4805 bug, the same class as the
 * AAASM-4797 OpenAI-Agents fix: `captureOriginalToolFactory` returned `undefined`,
 * `patchVercelAiSdk` returned false, and emitted zero warning — leaving Vercel AI
 * tools ungoverned in silence under enforce). Instead we warn loudly on stderr
 * and, under a fail-closed (enforce) posture, throw a `ConfigurationError` rather
 * than run ungoverned. `ai` simply not being installed stays a silent no-op (a
 * bare dependency install must remain zero-config).
 *
 * The SAME silent-fail-open class has a second, frozen sub-case (AAASM-4842): a
 * real `ai` ES module namespace is a frozen exotic object, so the governed factory
 * cannot be written back onto it — it lands only in a shim copy the application
 * never reads (`import { tool } from "ai"` keeps the ORIGINAL, ungoverned factory).
 * The pre-4842 code still reported that as a successful patch (returned true,
 * surfaced `vercelAiSdkPatched`/an active adapter, emitted no warning). We now warn
 * loudly and never report patched-success for that path. Unlike the moved-hook
 * case, the throw is gated on the separate `throwOnFrozenInert` option, NOT on
 * `failClosed`: a frozen namespace is the shape of EVERY real `ai`, so the
 * auto-detected init path only WARNS (hard-failing init on mere presence of `ai`
 * would regress zero-config, AAASM-1847, and the auto-detected warn-not-throw
 * invariant, AAASM-4769) — only a direct/explicit caller opts into the throw.
 */
import type {
  VercelAiToolDefinition,
  VercelAiToolExecutionOptions,
  VercelAiToolFactory
} from "../types/vercel-ai-adapter.js";
import type { GatewayClient } from "../gateway/client.js";
import { ConfigurationError } from "../errors/index.js";
import { PolicyViolationError } from "../errors/policy-violation-error.js";
import { runWithAgentId } from "../lineage/agent-context-store.js";

export interface VercelAiSdkModule {
  tool: VercelAiToolFactory;
}

export interface VercelAiSdkPatchState {
  isPatched: boolean;
  originalToolFactory: VercelAiToolFactory | undefined;
  /**
   * The writable module object whose `tool` factory was governed in place. Only
   * ever set when the governed factory was successfully assigned back onto the
   * loaded module (a writable plain object). A real `ai` ES module is a frozen
   * namespace whose `tool` export is non-writable, so no governed factory can be
   * written back; that path warns/throws and records no state rather than store an
   * inert shim copy the app never reads (AAASM-4842).
   */
  patchedModule: VercelAiSdkModule | undefined;
  /**
   * Always `true` when `isPatched` — the patch only records state after it assigned
   * the governed `tool` factory back onto a writable module. The frozen-ESM path,
   * where that write is impossible, never reaches here (it warns and, under enforce,
   * throws — AAASM-4842). Retained so `unpatchVercelAiSdk` can write the original
   * factory back over the one it overwrote.
   */
  mutatedOriginal: boolean;
  /**
   * Signature of the config the FIRST successful patch ran under, so a later
   * re-patch attempt (single patch per process) can detect a differing config
   * and warn rather than silently ignore the new posture (AAASM-4830).
   */
  patchConfigSignature: string | undefined;
}

export const vercelAiSdkPatchState: VercelAiSdkPatchState = {
  isPatched: false,
  originalToolFactory: undefined,
  patchedModule: undefined,
  mutatedOriginal: false,
  patchConfigSignature: undefined
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

    // Let check / approval faults propagate (reject) instead of swallowing them
    // into a silent fail-open. A caller-supplied gatewayClient that throws on a
    // transport error must NOT be treated as ALLOW — this matches the
    // with-assembly / wrap-tool wrappers, whose un-caught check() rejects and
    // blocks the tool under enforce (AAASM-4137).
    const decision = await gatewayClient.check({
      action: "tool_call",
      toolName: description,
      args,
      runId
    });

    if (decision.denied) {
      throw new PolicyViolationError(
        `Tool blocked by governance policy: ${decision.reason ?? "Denied"}`
      );
    }

    if (decision.pending) {
      const approval = await gatewayClient.waitForApproval(
        description,
        runId,
        options.approvalTimeoutMs
      );
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
  /**
   * When `ai` is installed but its `tool` factory hook point is absent — the
   * export is not a function because the upstream API MOVED (AAASM-4805) — throw a
   * `ConfigurationError` instead of only warning. Set from the caller's fail-closed
   * (enforce) posture. Scoped to the moved-hook case ONLY: it does NOT gate the
   * frozen-namespace throw (see `throwOnFrozenInert`), because a moved hook is a
   * rare broken/pinned-version state, whereas a frozen namespace is the shape of
   * EVERY real `ai` install — hard-failing init on mere presence of `ai` would
   * regress zero-config (AAASM-1847) and the auto-detected warn-not-throw invariant
   * (AAASM-4769).
   */
  failClosed?: boolean;
  /**
   * When the governed factory cannot be written back onto a frozen `ai` ES module
   * namespace (governance is inert — AAASM-4842), throw a `ConfigurationError`
   * instead of only warning. Deliberately SEPARATE from `failClosed`: the
   * auto-detected init path (`patchDetectedVercelAiSdk`) leaves this off so a bare
   * `ai` install stays zero-config and only WARNS (mirroring how AAASM-4769 handles
   * the analogous inert auto-detected framework), while a direct/explicit caller
   * that opts into hard enforcement can set it to fail loudly.
   */
  throwOnFrozenInert?: boolean;
  loadModule?: () => Promise<VercelAiSdkModule | undefined>;
}

/**
 * Attempt to install `governed` as the module's `tool` factory in place, reporting
 * via `mutatedOriginal` whether that write actually landed on the loaded module.
 *
 * A writable plain object (the shape used by the unit / conformance `loadModule`
 * fakes) is mutated in place and reports `mutatedOriginal: true`. A real `ai`
 * package loaded via `import()` is an ES module whose named exports are
 * non-writable, so `module.tool = …` throws `Cannot assign to read only property
 * 'tool'` (AAASM-3532); that case is caught and reported as `mutatedOriginal:
 * false`. The returned shim copy is a diagnostic byproduct, NOT a working patch —
 * the caller (`patchVercelAiSdk`) treats `mutatedOriginal: false` as the ungoverned
 * frozen-namespace path and warns/throws rather than install the inert shim,
 * because the app's own `import { tool } from "ai"` binding keeps pointing at the
 * original, ungoverned factory (AAASM-4842).
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

/**
 * Loud, un-silenceable signal that `ai` is installed but its `tool` factory
 * export has moved past the hook point this SDK knows — the failure mode
 * AAASM-4805 closes. Written straight to `process.stderr` (not a swappable
 * logger), mirroring the AAASM-4797 OpenAI-Agents missing-hook warning.
 */
function warnVercelAiHookPointMissing(): void {
  process.stderr.write(
    `[agent-assembly] WARNING: the Vercel AI SDK ("ai") is installed but its ` +
      `tool factory (the "tool" export) was not found — the installed version's ` +
      `tool API has moved. Vercel AI SDK tool calls will NOT be governed by this ` +
      `SDK: a policy DENY will NOT block a tool call. Pin "ai" to a supported ` +
      `version or upgrade @agent-assembly/sdk (AAASM-4805).\n`
  );
}

/**
 * Loud, un-silenceable signal that `ai` is installed as a frozen ES module, so the
 * governed `tool` factory could not be written back onto the `ai` namespace and the
 * app's `import { tool } from "ai"` stays ungoverned — the AAASM-4842 frozen
 * sub-case of the AAASM-4805/4797 silent-fail-open class. Written straight to
 * `process.stderr` (not a swappable logger), mirroring
 * {@link warnVercelAiHookPointMissing}.
 */
function warnVercelAiFrozenNamespaceInert(): void {
  process.stderr.write(
    `[agent-assembly] WARNING: the Vercel AI SDK ("ai") is installed as a frozen ` +
      `ES module namespace, so @agent-assembly/sdk could not install its governed ` +
      `"tool" factory onto it. Vercel AI SDK tool calls will NOT be governed by ` +
      `this SDK: your app's \`import { tool } from "ai"\` keeps the original, ` +
      `ungoverned factory and a policy DENY will NOT block a tool call. Import a ` +
      `governed tool factory from "@agent-assembly/sdk" instead of "ai" ` +
      `(AAASM-4842).\n`
  );
}

/**
 * A patch installs a governed `tool` factory as a process-global singleton, so
 * only the first config can ever be in effect. This distills the config fields
 * whose divergence would mislead an operator into believing a second
 * `initAssembly` changed the tool-governance posture — the enforce/fail-closed
 * posture, the approval knobs, and the lineage `agentId` — into a comparable
 * signature. The `gatewayClient` object identity is deliberately excluded:
 * every `initAssembly` builds a fresh client, so comparing it would warn on
 * every double-init even when the posture is unchanged.
 */
function vercelAiConfigSignature(options: PatchVercelAiSdkOptions): string {
  return JSON.stringify({
    failClosed: options.failClosed === true,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 30_000,
    fallbackRunId: options.fallbackRunId ?? "vercel-ai-sdk",
    agentId: options.agentId ?? null
  });
}

/**
 * Loud, un-silenceable signal that a second `initAssembly` tried to re-patch
 * the Vercel AI SDK with a DIFFERENT config while an earlier patch is installed.
 * The singleton early return keeps the FIRST governed factory/gatewayClient in
 * effect, so the new posture (e.g. observe→enforce) silently does NOT take
 * effect. Written straight to `process.stderr` (not a swappable logger) so an
 * operator can't be misled into believing the re-init changed anything
 * (AAASM-4830).
 */
function warnVercelAiRepatchIgnored(): void {
  process.stderr.write(
    `[agent-assembly] WARNING: the Vercel AI SDK ("ai") is already patched by an ` +
      `earlier initAssembly with a different configuration. Tool governance is a ` +
      `single patch per process, so the FIRST configuration stays in effect — ` +
      `this re-init did NOT change the tool-governance posture (a switched ` +
      `enforcement posture, agentId, or approval settings has NO effect). Restart ` +
      `the process to apply a new configuration (AAASM-4830).\n`
  );
}

export async function patchVercelAiSdk(
  options: PatchVercelAiSdkOptions
): Promise<boolean> {
  if (vercelAiSdkPatchState.isPatched) {
    // Single patch per process (the governed factory replaces the module's
    // `tool` export): the early return keeps the first config. Warn loudly if
    // this re-init carries a different config so the new posture isn't silently
    // ignored.
    if (
      vercelAiSdkPatchState.patchConfigSignature !== undefined &&
      vercelAiSdkPatchState.patchConfigSignature !== vercelAiConfigSignature(options)
    ) {
      warnVercelAiRepatchIgnored();
    }
    return true;
  }

  const loadModule = options.loadModule ?? loadVercelAiSdkModule;
  const module = await loadModule();
  if (!module) {
    // `ai` is not installed / did not load. A bare dependency install must stay
    // zero-config (AAASM-1847) — return silently, not loudly.
    return false;
  }

  const originalToolFactory = captureOriginalToolFactory(module);
  if (!originalToolFactory) {
    // `ai` IS installed but its `tool` hook point is gone: the upstream API
    // moved. Never silently no-op (AAASM-4805) — warn loudly, and under enforce
    // throw rather than leave tools ungoverned.
    warnVercelAiHookPointMissing();
    if (options.failClosed) {
      throw new ConfigurationError(
        `The Vercel AI SDK ("ai") is installed but its "tool" factory export was ` +
          `not found, so this SDK cannot govern Vercel AI SDK tool calls. Refusing ` +
          `to register under enforce rather than run ungoverned. Pin "ai" to a ` +
          `supported version, upgrade @agent-assembly/sdk, or set enforcementMode ` +
          `to "observe"/"disabled" (AAASM-4805).`
      );
    }
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

  if (!mutatedOriginal) {
    // AAASM-4842: the governed factory could not be written back onto the loaded
    // `ai` module — a real `ai` ES module namespace is frozen, so it lands only in
    // a shim copy the app never reads while `import { tool } from "ai"` keeps the
    // ORIGINAL, ungoverned factory. This is the AAASM-4805/4797 silent-fail-open
    // class, frozen sub-case: reporting patched-success here would over-claim a
    // governance that never reaches the app. Never silently no-op — warn loudly,
    // and record NO patch state (isPatched stays false) so init does not surface
    // `vercelAiSdkPatched` or an active adapter for this ungoverned path.
    //
    // The throw is gated on `throwOnFrozenInert`, NOT `failClosed`: a frozen
    // namespace is the shape of every real `ai`, so hard-failing init on mere
    // presence would regress zero-config (AAASM-1847) and the auto-detected
    // warn-not-throw invariant (AAASM-4769). The auto-detected init path therefore
    // only warns here; a direct/explicit caller opting into hard enforcement can
    // set `throwOnFrozenInert` to fail loudly instead.
    warnVercelAiFrozenNamespaceInert();
    if (options.throwOnFrozenInert) {
      throw new ConfigurationError(
        `The Vercel AI SDK ("ai") is installed as a frozen ES module, so this SDK ` +
          `cannot write its governed "tool" factory onto the "ai" namespace — your ` +
          `app's \`import { tool } from "ai"\` stays ungoverned and a policy DENY ` +
          `will NOT block a tool call. Refusing to register rather than run ` +
          `ungoverned. Import a governed tool factory from "@agent-assembly/sdk" ` +
          `instead of "ai", or set enforcementMode to "observe"/"disabled" ` +
          `(AAASM-4842).`
      );
    }
    return false;
  }

  vercelAiSdkPatchState.isPatched = true;
  vercelAiSdkPatchState.patchedModule = patchedModule;
  vercelAiSdkPatchState.mutatedOriginal = mutatedOriginal;
  vercelAiSdkPatchState.patchConfigSignature = vercelAiConfigSignature(options);
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
  vercelAiSdkPatchState.patchConfigSignature = undefined;
  return true;
}
