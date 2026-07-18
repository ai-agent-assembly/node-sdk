/**
 * AAASM-4830 — two operator-visibility gaps in the framework hooks:
 *
 * 1. Each framework patch is a process-global singleton (it mutates a shared
 *    prototype / module export), so a second `initAssembly` early-returns and
 *    reuses the first patch/gatewayClient. Previously that happened with NO
 *    signal, so an operator switching posture (e.g. observe→enforce) on a
 *    re-init could believe the new config took effect when it did not. The fix:
 *    an un-silenceable stderr WARNING when a re-patch is attempted with a
 *    DIFFERENT config (the early-return behaviour is kept — single config per
 *    process is inherent — just made loud).
 *
 * 2. Mastra and LangGraph are lineage-only (NON_ENFORCING_MODULES): they tag
 *    parent→child agent context but perform NO in-process tool-governance
 *    check, unlike vercel/openai. Previously they emitted no operator note, so
 *    an operator under enforce could assume a policy DENY blocks their tool
 *    calls in-process. The fix: a one-time stderr NOTE when they are patched
 *    under an enforce posture, clarifying tool calls are lineage-tagged only
 *    (the proxy/eBPF layers remain authoritative).
 *
 * stderr is captured with a `process.stderr.write` spy (the warnings/notes go
 * straight to stderr, not a swappable logger, so they can't be silenced).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { VercelAiSdkModule } from "../src/hooks/ai-sdk.js";
import type { OpenAIAgentsAgentClass } from "../src/hooks/openai-agents.js";
import type { LangGraphModule } from "../src/hooks/langgraph.js";
import type { MastraModule } from "../src/hooks/mastra.js";

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

function fakeVercelModule(): VercelAiSdkModule {
  return { tool: (definition) => definition };
}

function fakeOpenAIAgentClass(): OpenAIAgentsAgentClass {
  return { prototype: { _runTool: vi.fn(async () => ({ type: "function_call_result" })) } };
}

function fakeLangGraphModule(): LangGraphModule {
  return {
    StateGraph: {
      prototype: {
        compile: () => ({
          invoke: vi.fn(async () => undefined),
          stream: vi.fn(async () => undefined)
        })
      }
    }
  };
}

function fakeMastraModule(): MastraModule {
  return { Agent: { prototype: { generate: vi.fn(async () => ({})) } } };
}

function stderrMessages(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

const REPATCH_WARNING = "already patched by an earlier initAssembly with a different";
const LINEAGE_NOTE = "performs NO in-process tool-governance check";

afterEach(async () => {
  const openai = await import("../src/hooks/openai-agents.js");
  openai.unpatchOpenAIAgents();
  openai.openAIAgentsPatchState.isPatched = false;
  openai.openAIAgentsPatchState.patchConfigSignature = undefined;

  const vercel = await import("../src/hooks/ai-sdk.js");
  vercel.unpatchVercelAiSdk();
  vercel.vercelAiSdkPatchState.isPatched = false;
  vercel.vercelAiSdkPatchState.originalToolFactory = undefined;
  vercel.vercelAiSdkPatchState.patchConfigSignature = undefined;

  const langgraph = await import("../src/hooks/langgraph.js");
  langgraph.unpatchLangGraph();
  langgraph.langGraphPatchState.isPatched = false;
  langgraph.langGraphPatchState.patchConfigSignature = undefined;

  const mastra = await import("../src/hooks/mastra.js");
  mastra.unpatchMastra();
  mastra.mastraPatchState.isPatched = false;
  mastra.mastraPatchState.patchConfigSignature = undefined;

  vi.restoreAllMocks();
});

describe("AAASM-4830: re-patch with a different config emits a loud warning", () => {
  it("openai-agents: warns when a re-patch flips the enforce posture", async () => {
    const hooks = await import("../src/hooks/openai-agents.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchOpenAIAgents({
      gatewayClient: createGatewayClientMock(),
      failClosed: false,
      loadAgentClass: async () => fakeOpenAIAgentClass()
    });
    expect(stderrMessages(stderrSpy)).not.toContain(REPATCH_WARNING);

    // Second init with a DIFFERENT posture (enforce): the early return keeps the
    // first patch, but the operator must be warned the new posture is ignored.
    const repatched = await hooks.patchOpenAIAgents({
      gatewayClient: createGatewayClientMock(),
      failClosed: true,
      loadAgentClass: async () => fakeOpenAIAgentClass()
    });

    expect(repatched).toBe(true);
    expect(stderrMessages(stderrSpy)).toContain(REPATCH_WARNING);
  });

  it("openai-agents: does NOT warn when the re-patch config is identical", async () => {
    const hooks = await import("../src/hooks/openai-agents.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const opts = { failClosed: true, loadAgentClass: async () => fakeOpenAIAgentClass() };
    await hooks.patchOpenAIAgents({ gatewayClient: createGatewayClientMock(), ...opts });
    await hooks.patchOpenAIAgents({ gatewayClient: createGatewayClientMock(), ...opts });

    expect(stderrMessages(stderrSpy)).not.toContain(REPATCH_WARNING);
  });

  it("vercel-ai-sdk: warns when a re-patch flips the enforce posture", async () => {
    const hooks = await import("../src/hooks/ai-sdk.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchVercelAiSdk({
      gatewayClient: createGatewayClientMock(),
      failClosed: false,
      loadModule: async () => fakeVercelModule()
    });
    expect(stderrMessages(stderrSpy)).not.toContain(REPATCH_WARNING);

    const repatched = await hooks.patchVercelAiSdk({
      gatewayClient: createGatewayClientMock(),
      failClosed: true,
      loadModule: async () => fakeVercelModule()
    });

    expect(repatched).toBe(true);
    expect(stderrMessages(stderrSpy)).toContain(REPATCH_WARNING);
  });

  it("langgraph: warns when a re-patch carries a different agentId", async () => {
    const hooks = await import("../src/hooks/langgraph.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchLangGraph({ agentId: "agent-a", loadModule: async () => fakeLangGraphModule() });
    const repatched = await hooks.patchLangGraph({
      agentId: "agent-b",
      loadModule: async () => fakeLangGraphModule()
    });

    expect(repatched).toBe(true);
    expect(stderrMessages(stderrSpy)).toContain(REPATCH_WARNING);
  });

  it("mastra: warns when a re-patch carries a different agentId", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchMastra({ agentId: "agent-a", loadModule: async () => fakeMastraModule() });
    const repatched = await hooks.patchMastra({
      agentId: "agent-b",
      loadModule: async () => fakeMastraModule()
    });

    expect(repatched).toBe(true);
    expect(stderrMessages(stderrSpy)).toContain(REPATCH_WARNING);
  });

  it("mastra: does NOT warn when the re-patch agentId is identical", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchMastra({ agentId: "agent-a", loadModule: async () => fakeMastraModule() });
    await hooks.patchMastra({ agentId: "agent-a", loadModule: async () => fakeMastraModule() });

    expect(stderrMessages(stderrSpy)).not.toContain(REPATCH_WARNING);
  });
});

describe("AAASM-4830: lineage-only frameworks note their non-enforcement under enforce", () => {
  it("langgraph: emits the lineage-only note under a fail-closed (enforce) posture", async () => {
    const hooks = await import("../src/hooks/langgraph.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchLangGraph({
      agentId: "agent-1",
      failClosed: true,
      loadModule: async () => fakeLangGraphModule()
    });

    const messages = stderrMessages(stderrSpy);
    expect(messages).toContain(LINEAGE_NOTE);
    expect(messages).toContain("LangGraph");
  });

  it("langgraph: does NOT emit the note when the posture is not fail-closed", async () => {
    const hooks = await import("../src/hooks/langgraph.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchLangGraph({
      agentId: "agent-1",
      failClosed: false,
      loadModule: async () => fakeLangGraphModule()
    });

    expect(stderrMessages(stderrSpy)).not.toContain(LINEAGE_NOTE);
  });

  it("mastra: emits the lineage-only note under a fail-closed (enforce) posture", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchMastra({
      agentId: "agent-1",
      failClosed: true,
      loadModule: async () => fakeMastraModule()
    });

    const messages = stderrMessages(stderrSpy);
    expect(messages).toContain(LINEAGE_NOTE);
    expect(messages).toContain("Mastra");
  });

  it("mastra: does NOT emit the note when the posture is not fail-closed", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await hooks.patchMastra({
      agentId: "agent-1",
      failClosed: false,
      loadModule: async () => fakeMastraModule()
    });

    expect(stderrMessages(stderrSpy)).not.toContain(LINEAGE_NOTE);
  });
});
