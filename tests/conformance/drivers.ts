/**
 * Integration-driver registry for the fail-open conformance matrix (AAASM-4801).
 *
 * This is the anti-whack-a-mole core of the suite. Every per-round node fail-open
 * finding (AAASM-4735 → 4797/4798/4799) was the *same* class of bug — a governance
 * seam that let a tool run when it should have been blocked — rediscovered in a
 * different integration each sweep. Rather than add one more single-integration
 * regression test, this registry pins the invariant for *all* enforcement
 * integrations at once and forces any new integration to declare a driver
 * (see the completeness test in `fail-open-conformance.test.ts`).
 *
 * A DRIVER builds a fake tool, invokes the REAL wrapper/patch against the REAL
 * gateway client (`createNativeGatewayClient`) backed by a fake native runtime
 * configured per scenario, and reports whether the fake tool actually RAN. The
 * matrix iterates DRIVERS × SCENARIOS × MODES and asserts the fail-open/closed
 * invariant on the `ran` flag. Wiring the real gateway client (not a hand-mocked
 * decision) means a bug in EITHER the wrapper OR the shared `resolveVerdict` /
 * fail-closed path (AAASM-4798) trips the matrix.
 */
import { vi } from "vitest";
import { createNativeGatewayClient, type GatewayClient } from "../../src/gateway/client.js";
import type { NativeClient, PolicyResult } from "../../src/native/client.js";
import { NativeQueryPolicyError } from "../../src/native/client.js";
import type { EnforcementMode } from "../../src/types/enforcement-mode.js";
import { wrapToolWithAssembly } from "../../src/adapters/langchain/wrap-tool-with-assembly.js";
import type { LangChainToolLike } from "../../src/types/langchain-adapter.js";
import { withAssembly } from "../../src/wrappers/with-assembly.js";
import {
  patchVercelAiSdk,
  vercelAiSdkPatchState,
  type VercelAiSdkModule
} from "../../src/hooks/ai-sdk.js";
import type {
  VercelAiToolDefinition,
  VercelAiToolFactory
} from "../../src/types/vercel-ai-adapter.js";
import { openAIAgentsPatchState, patchOpenAIAgents } from "../../src/hooks/openai-agents.js";

export type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";
export type ModeId = "enforce" | "omitted" | "observe" | "disabled";

/**
 * A scenario `kind` fixes the expected fail-open/closed truth table
 * ({@link expectRan}):
 *  - `fault` / `missing-hook` — non-authoritative outcome (unreachable runtime,
 *    transport error, malformed-but-resolved verdict, pending with no approval
 *    channel, or a moved upstream hook). Fail *closed* under enforce (deny),
 *    fail *open* under observe/disabled.
 *  - `authoritative-deny` — a real DENY verdict. Blocks in EVERY mode; a deny is
 *    authoritative, not a fault, so observe/disabled do not downgrade it.
 *  - `authoritative-allow` — a real ALLOW verdict. Runs in every mode.
 */
export type ScenarioKind = "fault" | "missing-hook" | "authoritative-deny" | "authoritative-allow";

export interface Scenario {
  id: ScenarioId;
  label: string;
  kind: ScenarioKind;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: "S1", label: "gateway unreachable", kind: "fault" },
  { id: "S2", label: "transport/governance error", kind: "fault" },
  { id: "S3", label: "unknown/malformed but RESOLVED verdict (AAASM-4798)", kind: "fault" },
  { id: "S4", label: "missing/renamed hook point (AAASM-4797)", kind: "missing-hook" },
  { id: "S5", label: "pending-approval, no approval channel", kind: "fault" },
  { id: "S6", label: "deny + deny-audit throws", kind: "authoritative-deny" },
  { id: "S7", label: "explicit DENY (control)", kind: "authoritative-deny" },
  { id: "S8", label: "explicit ALLOW (control)", kind: "authoritative-allow" }
];

export interface Mode {
  id: ModeId;
  enforcementMode: EnforcementMode | undefined;
  /** Resolved fail-closed posture: enforce and omitted fail closed; the rest open. */
  failClosed: boolean;
}

export const MODES: readonly Mode[] = [
  { id: "enforce", enforcementMode: "enforce", failClosed: true },
  { id: "omitted", enforcementMode: undefined, failClosed: true },
  { id: "observe", enforcementMode: "observe", failClosed: false },
  { id: "disabled", enforcementMode: "disabled", failClosed: false }
];

/**
 * The single source of truth for the conformance invariant.
 *
 * A tool MUST run iff the outcome is a genuine ALLOW, or the outcome is
 * non-authoritative (fault / missing hook) AND the posture is fail-open. Under a
 * fail-closed posture every non-authoritative outcome blocks; an authoritative
 * DENY blocks regardless of posture.
 */
export function expectRan(scenario: Scenario, mode: Mode): boolean {
  switch (scenario.kind) {
    case "authoritative-allow":
      return true;
    case "authoritative-deny":
      return false;
    case "fault":
    case "missing-hook":
      return !mode.failClosed;
  }
}

export interface ScenarioOutcome {
  /** Did the underlying fake tool body execute? The invariant is asserted on this. */
  ran: boolean;
  /** Did governance stop the call (threw, or returned a denial output)? */
  blocked: boolean;
  threw?: unknown;
  output?: unknown;
}

export interface Driver {
  name: string;
  /** Source module (relative to `src/`) this driver exercises — keyed by the completeness test. */
  file: string;
  supports: (scenario: ScenarioId) => boolean;
  run: (scenario: Scenario, mode: Mode) => Promise<ScenarioOutcome>;
}

const AGENT_ID = "conformance-agent";
const FAST_APPROVAL_TIMEOUT_MS = 50;

/**
 * Fake native runtime whose `queryPolicy` reproduces each scenario at the exact
 * JS/native boundary the real client distrusts:
 *  - S1/S2 throw (unreachable / transport fault) → the client's catch block.
 *  - S3 resolves a shape with no recognizable signal → the `resolveVerdict` guard.
 *  - S5 resolves `pending` → the approval path.
 *  - S6/S7 resolve a real deny; S8 a real allow.
 * S4 is a patch-layer scenario (a moved upstream hook) and never reaches here.
 */
function buildFakeNative(scenario: ScenarioId): NativeClient {
  const queryPolicy: NativeClient["queryPolicy"] = async (): Promise<PolicyResult> => {
    switch (scenario) {
      case "S1":
        throw new Error("ECONNREFUSED: gateway unreachable");
      case "S2":
        throw new NativeQueryPolicyError("transport/governance error");
      case "S3":
        // Resolves without a recognizable denied/pending signal (AAASM-4798).
        return {} as PolicyResult;
      case "S5":
        return { denied: false, pending: true, reason: "awaiting approval" };
      case "S6":
        return { denied: true, pending: false, reason: "policy deny (audit will throw)" };
      case "S7":
        return { denied: true, pending: false, reason: "explicit deny" };
      case "S4":
      case "S8":
        return { denied: false, pending: false };
    }
  };
  return {
    mode: "napi-inprocess",
    canRegister: true,
    close: async () => undefined,
    sendEvent: () => undefined,
    queryPolicy,
    register: async () => ""
  };
}

/**
 * The REAL gateway client under test, wired to the scenario's fake runtime and
 * the mode's posture. For S6 the audit sinks are overridden to reject so the
 * matrix proves a deny is not downgraded when the post-deny audit record throws.
 */
function buildRealGateway(scenario: ScenarioId, mode: Mode): GatewayClient {
  const base = createNativeGatewayClient(
    "napi-inprocess",
    buildFakeNative(scenario),
    AGENT_ID,
    undefined,
    mode.enforcementMode
  );
  if (scenario === "S6") {
    return {
      ...base,
      record: async () => {
        throw new Error("audit sink down");
      },
      recordResult: async () => {
        throw new Error("audit sink down");
      }
    };
  }
  return base;
}

const DENIAL_OUTPUT = /Blocked by governance policy|Approval denied/;

function isDenialOutput(output: unknown): boolean {
  return typeof output === "string" && DENIAL_OUTPUT.test(output);
}

interface RanFlag {
  ran: boolean;
}

async function invokeAndClassify(
  invoke: () => Promise<unknown>,
  state: RanFlag
): Promise<ScenarioOutcome> {
  let threw: unknown;
  let output: unknown;
  try {
    output = await invoke();
  } catch (error) {
    threw = error;
  }
  const blocked = threw !== undefined || isDenialOutput(output);
  return { ran: state.ran, blocked, threw, output };
}

const notS4 = (scenario: ScenarioId): boolean => scenario !== "S4";
const allScenarios = (): boolean => true;

async function runLangchain(scenario: Scenario, mode: Mode): Promise<ScenarioOutcome> {
  const gateway = buildRealGateway(scenario.id, mode);
  const state: RanFlag = { ran: false };
  const tool: LangChainToolLike = {
    name: "delete_db",
    invoke: async () => {
      state.ran = true;
      return "did-run";
    }
  };
  const wrapped = wrapToolWithAssembly(tool, gateway, {
    approvalTimeoutMs: FAST_APPROVAL_TIMEOUT_MS
  });
  return invokeAndClassify(() => wrapped.invoke({ any: "input" }), state);
}

async function runWithAssembly(scenario: Scenario, mode: Mode): Promise<ScenarioOutcome> {
  const gateway = buildRealGateway(scenario.id, mode);
  const state: RanFlag = { ran: false };
  const tools = {
    delete_db: {
      execute: async () => {
        state.ran = true;
        return "did-run";
      }
    }
  };
  const wrapped = withAssembly(tools, {
    gatewayClient: gateway,
    approvalTimeoutMs: FAST_APPROVAL_TIMEOUT_MS
  });
  return invokeAndClassify(() => wrapped.delete_db.execute(), state);
}

/** Reset the Vercel patch singleton so each driver run patches from a clean slate. */
export function resetVercelState(): void {
  vercelAiSdkPatchState.isPatched = false;
  vercelAiSdkPatchState.originalToolFactory = undefined;
  vercelAiSdkPatchState.patchedModule = undefined;
  vercelAiSdkPatchState.mutatedOriginal = false;
}

async function runVercelMissingHook(mode: Mode, state: RanFlag): Promise<ScenarioOutcome> {
  // Upstream API moved: `ai` IS installed but its `tool` factory export is gone —
  // the exact AAASM-4805 shape (captureOriginalToolFactory returns undefined).
  // Under enforce the patch must throw loudly; under observe/disabled it warns and
  // returns unpatched (the app's tool then runs ungoverned).
  resetVercelState();
  const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  let threw: unknown;
  try {
    await patchVercelAiSdk({
      gatewayClient: buildRealGateway("S4", mode),
      failClosed: mode.failClosed,
      // A module with no `tool` function: installed-but-hook-missing.
      loadModule: async () => ({}) as never
    });
  } catch (error) {
    threw = error;
  } finally {
    stderrSpy.mockRestore();
    resetVercelState();
  }
  if (threw !== undefined) {
    return { ran: false, blocked: true, threw };
  }
  // Fail-open path: the patch declined to attach, so the tool is ungoverned and
  // would execute unimpeded.
  state.ran = true;
  return { ran: state.ran, blocked: false };
}

async function runVercel(scenario: Scenario, mode: Mode): Promise<ScenarioOutcome> {
  resetVercelState();
  const state: RanFlag = { ran: false };
  if (scenario.id === "S4") {
    return runVercelMissingHook(mode, state);
  }
  const gateway = buildRealGateway(scenario.id, mode);
  // Identity factory standing in for `ai.tool` — the wrapper wraps whatever
  // `execute` the produced tool exposes. This driver's `loadModule` fake returns a
  // WRITABLE plain object, so applyGovernedToolFactory mutates it in place and the
  // governed factory is the one the caller reads back. That is NOT what a real `ai`
  // ES module looks like — its namespace is frozen — so this driver alone
  // over-states Vercel governance; the frozen-namespace truth is pinned separately
  // by `runVercelFrozenEsm` (AAASM-4822).
  const originalToolFactory: VercelAiToolFactory = <TArgs, TResult>(
    definition: VercelAiToolDefinition<TArgs, TResult>
  ): VercelAiToolDefinition<TArgs, TResult> => definition;
  await patchVercelAiSdk({
    gatewayClient: gateway,
    approvalTimeoutMs: FAST_APPROVAL_TIMEOUT_MS,
    loadModule: async () => ({ tool: originalToolFactory })
  });
  const governedFactory = vercelAiSdkPatchState.patchedModule?.tool;
  if (typeof governedFactory !== "function") {
    resetVercelState();
    throw new Error("vercel driver: patch did not install a governed tool factory");
  }
  const governed = governedFactory({
    description: "delete_db",
    parameters: {},
    execute: async () => {
      state.ran = true;
      return "did-run";
    }
  } as never) as { execute?: (args: unknown, options: unknown) => Promise<unknown> };
  const outcome = await invokeAndClassify(
    () => governed.execute!({ any: "input" }, { toolCallId: "call-1" }),
    state
  );
  resetVercelState();
  return outcome;
}

/**
 * The FROZEN-ESM Vercel path a real app actually hits — the honest counterpart to
 * {@link runVercel} (AAASM-4822).
 *
 * A real `ai` package imported via `import()` is an ES module whose namespace is
 * frozen: its named `tool` export is non-writable. `patchVercelAiSdk` therefore
 * cannot write the governed factory back onto it (that would throw the AAASM-3532
 * crash); it lands the governed factory only in an internal **shim copy**
 * (`vercelAiSdkPatchState.patchedModule`) that the application never reads. The
 * app's own `import { tool } from "ai"` binding keeps pointing at the ORIGINAL,
 * ungoverned factory.
 *
 * So this driver deliberately resolves the tool factory the way the app does — from
 * the frozen module object, NOT from the SDK's shim copy — which reflects that the
 * frozen-ESM path is **not governed today** (documented as a known limitation in
 * `docs/07-compatibility-versioning/compatibility.md`, AAASM-3532). The scenario's
 * verdict is irrelevant: governance never runs on this path, so the tool executes
 * unconditionally. The conformance test consumes this to assert the true (ungoverned)
 * behavior rather than let the matrix over-claim a Vercel block it cannot deliver.
 */
export async function runVercelFrozenEsm(
  scenario: Scenario,
  mode: Mode
): Promise<ScenarioOutcome> {
  resetVercelState();
  const state: RanFlag = { ran: false };
  const gateway = buildRealGateway(scenario.id, mode);
  const originalToolFactory: VercelAiToolFactory = <TArgs, TResult>(
    definition: VercelAiToolDefinition<TArgs, TResult>
  ): VercelAiToolDefinition<TArgs, TResult> => definition;
  // Object.freeze reproduces the non-writable named exports of a real `ai` ESM
  // namespace: this is the exact shape applyGovernedToolFactory must shim-copy
  // rather than mutate in place.
  const frozenAiModule: VercelAiSdkModule = Object.freeze({ tool: originalToolFactory });
  await patchVercelAiSdk({
    gatewayClient: gateway,
    approvalTimeoutMs: FAST_APPROVAL_TIMEOUT_MS,
    loadModule: async () => frozenAiModule
  });
  // The app reads `tool` from its own `import { tool } from "ai"` binding — the
  // frozen module object, NOT vercelAiSdkPatchState.patchedModule (the shim). On a
  // frozen namespace the patch could not write the governed factory back, so this
  // is the ORIGINAL ungoverned factory.
  const appFactory = frozenAiModule.tool;
  const appTool = appFactory({
    description: "delete_db",
    parameters: {},
    execute: async () => {
      state.ran = true;
      return "did-run";
    }
  } as never) as { execute?: (args: unknown, options: unknown) => Promise<unknown> };
  const outcome = await invokeAndClassify(
    () => appTool.execute!({ any: "input" }, { toolCallId: "call-1" }),
    state
  );
  resetVercelState();
  return outcome;
}

/** Reset the OpenAI-Agents patch singleton (a fresh fake Agent class is used each run). */
export function resetOpenAIState(): void {
  openAIAgentsPatchState.isPatched = false;
  openAIAgentsPatchState.hookPoint = undefined;
  openAIAgentsPatchState.originalRunTool = undefined;
  openAIAgentsPatchState.originalGetAllTools = undefined;
  openAIAgentsPatchState.patchedAgentClass = undefined;
}

async function runOpenAIMissingHook(mode: Mode, state: RanFlag): Promise<ScenarioOutcome> {
  // Upstream API moved: an Agent class with NEITHER getAllTools NOR _runTool —
  // the exact AAASM-4797 shape (the removed `_runTool` found no hook). Under
  // enforce the patch must throw loudly; under observe/disabled it warns and
  // returns unpatched (the app's tool then runs ungoverned).
  const brokenAgent = { prototype: {} };
  const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  let threw: unknown;
  try {
    await patchOpenAIAgents({
      gatewayClient: buildRealGateway("S4", mode),
      failClosed: mode.failClosed,
      loadAgentClass: async () => brokenAgent as never
    });
  } catch (error) {
    threw = error;
  } finally {
    stderrSpy.mockRestore();
    resetOpenAIState();
  }
  if (threw !== undefined) {
    return { ran: false, blocked: true, threw };
  }
  // Fail-open path: the patch declined to attach, so the tool is ungoverned and
  // would execute unimpeded.
  state.ran = true;
  return { ran: state.ran, blocked: false };
}

async function runOpenAI(scenario: Scenario, mode: Mode): Promise<ScenarioOutcome> {
  resetOpenAIState();
  const state: RanFlag = { ran: false };
  if (scenario.id === "S4") {
    return runOpenAIMissingHook(mode, state);
  }
  const gateway = buildRealGateway(scenario.id, mode);
  const fakeTool = {
    type: "function",
    name: "delete_db",
    invoke: async () => {
      state.ran = true;
      return "did-run";
    }
  };
  const agentClass = {
    prototype: {
      getAllTools: async () => [fakeTool]
    }
  };
  await patchOpenAIAgents({
    gatewayClient: gateway,
    approvalTimeoutMs: FAST_APPROVAL_TIMEOUT_MS,
    loadAgentClass: async () => agentClass as never
  });
  // getAllTools wraps each tool's invoke in place, mirroring the runtime path.
  const tools = await agentClass.prototype.getAllTools();
  const governed = tools[0] as {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  };
  const outcome = await invokeAndClassify(
    () => governed.invoke({}, JSON.stringify({ any: "input" })),
    state
  );
  resetOpenAIState();
  return outcome;
}

/**
 * The shared gateway path (`check()` + `resolveVerdict` + `waitForApproval`) with
 * no framework wrapper — models "would a tool run?" using the exact check/approval
 * logic the wrappers apply, so the shared seam is asserted independently of any
 * one integration.
 */
async function runGatewayCheck(scenario: Scenario, mode: Mode): Promise<ScenarioOutcome> {
  const gateway = buildRealGateway(scenario.id, mode);
  let ran = false;
  let blocked = false;
  let threw: unknown;
  try {
    const decision = await gateway.check({
      action: "tool_call",
      toolName: "delete_db",
      runId: "run-1"
    });
    if (decision.denied) {
      blocked = true;
    } else if (decision.pending) {
      const approval = await gateway.waitForApproval(
        "delete_db",
        "run-1",
        FAST_APPROVAL_TIMEOUT_MS
      );
      if (approval.denied) {
        blocked = true;
      } else {
        ran = true;
      }
    } else {
      ran = true;
    }
  } catch (error) {
    threw = error;
    blocked = true;
  }
  return { ran, blocked, threw };
}

export const DRIVERS: readonly Driver[] = [
  {
    name: "langchain (wrapToolWithAssembly)",
    file: "adapters/langchain/wrap-tool-with-assembly.ts",
    supports: notS4,
    run: runLangchain
  },
  {
    name: "vercel-ai (patchVercelAiSdk)",
    file: "hooks/ai-sdk.ts",
    supports: allScenarios,
    run: runVercel
  },
  {
    name: "openai-agents (patchOpenAIAgents)",
    file: "hooks/openai-agents.ts",
    supports: allScenarios,
    run: runOpenAI
  },
  {
    name: "with-assembly (withAssembly)",
    file: "wrappers/with-assembly.ts",
    supports: notS4,
    run: runWithAssembly
  },
  {
    name: "gateway check/resolveVerdict (shared path)",
    file: "gateway/client.ts",
    supports: notS4,
    run: runGatewayCheck
  }
];

/**
 * Integration source modules that are deliberately NOT enforcement drivers, each
 * with the reason it cannot gate a tool call. The completeness test requires
 * every integration module on disk to be either a {@link DRIVERS} entry or listed
 * here — so a newly added integration cannot slip in ungoverned and untested.
 */
export const NON_ENFORCING_MODULES: Readonly<Record<string, string>> = {
  "hooks/langchain.ts":
    "native-transport LangChain patch is an intentional no-op stub; enforcement is via wrapToolWithAssembly",
  "hooks/langgraph.ts":
    "lineage-only patch (runWithAgentId); performs no pre-exec governance check",
  "hooks/mastra.ts": "lineage-only patch (runWithAgentId); performs no pre-exec governance check",
  "adapters/langchain/assembly-callback-handler.ts":
    "audit-only callback; cannot block or redact (AAASM-4799); enforcement is via wrapToolWithAssembly"
};
