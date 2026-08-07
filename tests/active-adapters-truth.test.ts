/**
 * Adapter-state truthfulness controls for `initAssembly` (AAASM-5664, Epic AAASM-5526).
 *
 * `AssemblyContext.activeAdapters` is the field a caller reads to learn which
 * frameworks this SDK attached to. It was built by unioning the *detection* list
 * with a set of patch-success flags, and because every non-LangChain flag is
 * itself gated on detection, the union could only ever equal the detection list.
 * A framework that was found on disk but whose patch was warned to have failed
 * was therefore still reported active in that same run.
 *
 * That is the AAASM-5529 failure shape restated at the reporting layer: a
 * failed-adapter path displaying a protected/enforced success state. These
 * controls assert over the value a consumer actually reads (`ctx.*Adapters`),
 * paired against the un-silenceable stderr warning emitted by the same run, so
 * "active" cannot drift back into meaning "detected".
 *
 * Scope note, so these controls are not read as more than they are: membership in
 * `activeAdapters` is a claim about *mechanism* — a patch was applied and is
 * reachable — never about enforcement. LangGraph and Mastra are lineage-only
 * (`NON_ENFORCING_MODULES`, AAASM-4830), the LangChain callback layer is audit-only
 * (AAASM-4799), and every enforcing path degrades to a non-blocking check under the
 * allow-all no-op client. Where a control below can assert enforcement it does so
 * against the artifact that decides (a wrapped tool's `invoke` rejecting); where it
 * cannot, it says so rather than implying the stronger claim.
 *
 * Every negative control here is paired with a positive control over the same
 * framework and the same code path. Without the pair, "vercel-ai-sdk is absent
 * from activeAdapters" would be satisfied equally well by the fix working and
 * by the list being empty for an unrelated reason — which is exactly the class
 * of vacuous evidence this Epic exists to eliminate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { AssemblyConfig } from "../src/types/assembly-config.js";
import type { LangChainToolLike } from "../src/types/langchain-adapter.js";
import type {
  VercelAiToolDefinition,
  VercelAiToolFactory
} from "../src/types/vercel-ai-adapter.js";

function createGatewayClientMock(): GatewayClient {
  return {
    mode: "sdk-only",
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    check: vi.fn(async () => ({ denied: false, pending: false })),
    waitForApproval: vi.fn(async () => ({ denied: false })),
    record: vi.fn(async () => undefined),
    recordResult: vi.fn(async () => undefined),
    scanPrompts: vi.fn(async () => undefined)
  };
}

/** Make exactly `installed` resolvable, so `detectFrameworks` sees only those. */
function mockInstalledPackages(installed: ReadonlySet<string>): void {
  vi.doMock("node:module", () => ({
    createRequire: () => ({
      resolve: (packageName: string) => {
        if (!installed.has(packageName)) {
          throw new Error("MODULE_NOT_FOUND");
        }
        return packageName;
      }
    })
  }));
}

/**
 * Capture everything the run writes to stderr. `patchVercelAiSdk`'s inert-state
 * warning goes straight to `process.stderr` rather than through a swappable
 * logger precisely so it cannot be silenced, so that is where it must be read
 * from — asserting over a logger spy would not prove the operator saw it.
 */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return {
    text: () => chunks.join(""),
    restore: () => {
      spy.mockRestore();
    }
  };
}

/** The un-silenceable AAASM-4842 signal that Vercel governance is NOT in effect. */
const VERCEL_UNGOVERNED_WARNING = "Vercel AI SDK tool calls will NOT be governed by this SDK";

/** The AAASM-5664 signal that a detected LangChain had nothing to attach to. */
const LANGCHAIN_UNWIRED_WARNING = "LangChain activity will NOT be observed or governed";

afterEach(async () => {
  const hooks = await import("../src/hooks/ai-sdk.js");
  hooks.unpatchVercelAiSdk();
  hooks.vercelAiSdkPatchState.originalToolFactory = undefined;
  hooks.vercelAiSdkPatchState.patchedModule = undefined;
  hooks.vercelAiSdkPatchState.isPatched = false;
  hooks.vercelAiSdkPatchState.mutatedOriginal = false;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("activeAdapters reports only successfully patched adapters", () => {
  it("NEGATIVE CONTROL: a detected framework whose patch failed is not reported active", async () => {
    // The real `ai` package is a frozen ES module namespace, so the governed
    // `tool` factory cannot be written back onto it and `patchVercelAiSdk`
    // returns false after warning (AAASM-4842). No `vi.doMock("ai", ...)` here
    // on purpose: this is the shape every real install has.
    mockInstalledPackages(new Set(["ai"]));
    const stderr = captureStderr();

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: createGatewayClientMock()
    });

    const warnings = stderr.text();
    stderr.restore();

    // Guard the guard: if this run stopped emitting the ungoverned warning, the
    // fixture no longer reproduces a failed patch and every assertion below
    // would pass vacuously.
    expect(warnings).toContain(VERCEL_UNGOVERNED_WARNING);

    // The artifact a consumer reads. In the SAME run that warned the framework
    // is ungoverned, it must not be presented as active.
    expect(context.activeAdapters).not.toContain("vercel-ai-sdk");

    // ...and the three states stay distinguishable: the framework really was
    // found, it simply is not governed. Asserting only the omission above would
    // leave "not installed" and "installed but ungoverned" indistinguishable.
    expect(context.detectedAdapters).toContain("vercel-ai-sdk");
    expect(context.unpatchedAdapters).toContain("vercel-ai-sdk");
  });

  it("NEGATIVE CONTROL: a detected framework skipped for a missing prerequisite is not reported active", async () => {
    // LangGraph's patch is skipped outright when no `agentId` is supplied. That
    // is a different route to the same lie — detected, never patched — so it is
    // pinned separately rather than assumed to follow from the Vercel case.
    const fakeCompiled = { invoke: vi.fn(async () => ({})), stream: vi.fn(async () => ({})) };
    vi.doMock("@langchain/langgraph", () => ({
      StateGraph: { prototype: { compile: vi.fn(() => fakeCompiled) } }
    }));
    mockInstalledPackages(new Set(["@langchain/langgraph"]));

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: createGatewayClientMock()
      // agentId deliberately omitted — this is what makes the patch a no-op.
    });

    expect(context.detectedAdapters).toContain("langgraph-js");
    expect(context.activeAdapters).not.toContain("langgraph-js");
    expect(context.unpatchedAdapters).toContain("langgraph-js");
  });

  it("POSITIVE CONTROL: the same framework with its prerequisite met is reported active", async () => {
    // NOT an enforcement claim. LangGraph is in NON_ENFORCING_MODULES (AAASM-4830):
    // an applied patch installs lineage tagging and nothing else, so a policy DENY
    // still will not block a LangGraph tool call in-process. What this control pins
    // is only that a patch which DID take effect keeps its place in activeAdapters —
    // the counterweight that stops the negative controls above from being satisfied
    // by an always-empty list. The mechanism assertion below (the StateGraph
    // prototype was actually replaced) is what makes "took effect" observable rather
    // than merely asserted.
    const fakeCompiled = { invoke: vi.fn(async () => ({})), stream: vi.fn(async () => ({})) };
    const originalCompile = vi.fn(() => fakeCompiled);
    const stateGraph = { prototype: { compile: originalCompile } };
    vi.doMock("@langchain/langgraph", () => ({ StateGraph: stateGraph }));
    mockInstalledPackages(new Set(["@langchain/langgraph"]));

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: createGatewayClientMock(),
      agentId: "agent-5664-langgraph"
    });

    expect(context.activeAdapters).toContain("langgraph-js");
    expect(context.unpatchedAdapters).not.toContain("langgraph-js");
    // The artifact that decides whether the patch took effect: `compile` is no
    // longer the function we handed in. Asserting only the string membership would
    // be asserting over a proxy for the thing we care about.
    expect(stateGraph.prototype.compile).not.toBe(originalCompile);
  });

  it("NEGATIVE CONTROL: @langchain/core detected with no langchain config is not reported active", async () => {
    // AAASM-5664 / review B1. `initAssembly` patches a SHALLOW COPY of the caller's
    // config. With no caller-supplied `langchain`, `ensureLangChainCallbacks`'s `??=`
    // mints a fresh object on that copy, so the handler is pushed into an array the
    // caller can never read and is discarded when `initAssembly` returns. It used to
    // be credited as active anyway — the ticket's own defect, surviving in the one
    // branch that is not detection-gated.
    mockInstalledPackages(new Set(["@langchain/core"]));
    const stderr = captureStderr();

    const callerConfig: AssemblyConfig = {
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: createGatewayClientMock()
    };

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly(callerConfig);

    const warnings = stderr.text();
    stderr.restore();

    // Guard the guard: prove the handler really is unreachable in this fixture,
    // rather than trusting that the shallow-copy reasoning still holds. If the
    // caller could see it, the assertions below would be testing the wrong thing.
    expect(callerConfig.langchain).toBeUndefined();

    expect(context.detectedAdapters).toContain("langchain-js");
    expect(context.activeAdapters).not.toContain("langchain-js");
    expect(context.unpatchedAdapters).toContain("langchain-js");
    expect(warnings).toContain(LANGCHAIN_UNWIRED_WARNING);
  });

  it("POSITIVE CONTROL: explicit langchain config without @langchain/core installed governs tools", async () => {
    // The load-bearing case for keeping the two LangChain flags in
    // `patchedAdapterIds`: an explicit `config.langchain` wires the adapter up even
    // when the package does not resolve, so `langchain-js` is active while absent
    // from `detectedAdapters`. Deriving `active` from detection would silently drop
    // a genuinely governed adapter.
    //
    // Asserted over the artifact that decides — the tool's `invoke` must now reject
    // under a denying gateway — not over the string's presence in a list. A string
    // in an array is exactly the proxy evidence this Epic exists to replace.
    const denyingGateway = createGatewayClientMock();
    denyingGateway.check = vi.fn(async () => ({ denied: true, reason: "blocked by policy" }));
    const originalInvoke = vi.fn(async () => "send_email-ok");
    const tool: LangChainToolLike = { name: "send_email", invoke: originalInvoke };

    mockInstalledPackages(new Set([]));

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: denyingGateway,
      enforcementMode: "enforce",
      langchain: { tools: { sendEmail: tool } }
    });

    expect(context.activeAdapters).toContain("langchain-js");
    expect(context.detectedAdapters).not.toContain("langchain-js");

    // The decisive assertion: the tool is really wrapped, and the deny really stops
    // the underlying implementation from running.
    await expect(tool.invoke({ to: "user@example.com" })).rejects.toThrow("send_email");
    expect(originalInvoke).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a framework whose patch succeeded is still reported active", async () => {
    // A mutable module namespace accepts the governed factory, so the patch
    // genuinely succeeds. Without this case, the negative control above would
    // be satisfied by an always-empty list.
    const originalTool = vi.fn(
      (def: VercelAiToolDefinition) => def
    ) as unknown as VercelAiToolFactory;
    vi.doMock("ai", () => ({ tool: originalTool }));
    mockInstalledPackages(new Set(["ai"]));
    const stderr = captureStderr();

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: createGatewayClientMock()
    });

    const warnings = stderr.text();
    stderr.restore();

    const hooks = await import("../src/hooks/ai-sdk.js");
    expect(hooks.vercelAiSdkPatchState.isPatched).toBe(true);
    expect(warnings).not.toContain(VERCEL_UNGOVERNED_WARNING);
    expect(context.activeAdapters).toContain("vercel-ai-sdk");
  });
});
