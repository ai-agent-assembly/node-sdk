import { afterEach, describe, expect, it, vi } from "vitest";
import type { LangGraphModule, StateGraphClass } from "../src/hooks/langgraph.js";

afterEach(() => {
  return resetPatchState().finally(() => {
    vi.resetModules();
    vi.unmock("@langchain/langgraph");
  });
});

describe("langgraph hook", () => {
  it("wraps compiled graph invoke and stream with agent context", async () => {
    const hooks = await import("../src/hooks/langgraph.js");
    const lineage = await import("../src/lineage/agent-context-store.js");

    const invokeCapture: string[] = [];
    const streamCapture: string[] = [];

    const compiled = {
      invoke: vi.fn(async () => {
        invokeCapture.push(lineage.currentAgentId() ?? "none");
        return { result: "invoke-ok" };
      }),
      stream: vi.fn(async () => {
        streamCapture.push(lineage.currentAgentId() ?? "none");
        return { result: "stream-ok" };
      })
    };

    hooks.wrapCompiledGraph(compiled, "agent-abc");

    await compiled.invoke();
    await compiled.stream();

    expect(invokeCapture).toEqual(["agent-abc"]);
    expect(streamCapture).toEqual(["agent-abc"]);
  });

  it("patches StateGraph.prototype.compile and wraps returned graph", async () => {
    const hooks = await import("../src/hooks/langgraph.js");
    const lineage = await import("../src/lineage/agent-context-store.js");

    const invokeCapture: string[] = [];
    const fakeCompiled = {
      invoke: vi.fn(async () => {
        invokeCapture.push(lineage.currentAgentId() ?? "none");
        return {};
      }),
      stream: vi.fn(async () => ({}))
    };

    const fakeStateGraphClass: StateGraphClass = {
      prototype: {
        compile: vi.fn(() => fakeCompiled)
      }
    };
    const fakeModule: LangGraphModule = { StateGraph: fakeStateGraphClass };

    const patched = await hooks.patchLangGraph({
      agentId: "agent-xyz",
      loadModule: async () => fakeModule
    });

    expect(patched).toBe(true);
    expect(hooks.langGraphPatchState.isPatched).toBe(true);

    const graph = fakeStateGraphClass.prototype.compile!();
    await graph.invoke();

    expect(invokeCapture).toEqual(["agent-xyz"]);
  });

  it("returns false and does not patch when module is unavailable", async () => {
    const hooks = await import("../src/hooks/langgraph.js");

    const patched = await hooks.patchLangGraph({
      agentId: "agent-1",
      loadModule: async () => undefined
    });

    expect(patched).toBe(false);
    expect(hooks.langGraphPatchState.isPatched).toBe(false);
  });

  it("returns false when the module loader throws", async () => {
    const hooks = await import("../src/hooks/langgraph.js");

    const patched = await hooks.patchLangGraph({
      agentId: "agent-loader-throws",
      loadModule: async () => {
        throw new Error("module resolution exploded");
      }
    });

    expect(patched).toBe(false);
    expect(hooks.langGraphPatchState.isPatched).toBe(false);
  });

  it("returns false when StateGraph.prototype.compile is absent", async () => {
    const hooks = await import("../src/hooks/langgraph.js");

    const fakeModule: LangGraphModule = {
      StateGraph: { prototype: {} }
    };

    const patched = await hooks.patchLangGraph({
      agentId: "agent-2",
      loadModule: async () => fakeModule
    });

    expect(patched).toBe(false);
  });

  it("returns true without re-patching when already patched", async () => {
    const hooks = await import("../src/hooks/langgraph.js");

    const compileCall = vi.fn(() => ({ invoke: vi.fn(async () => ({})), stream: vi.fn(async () => ({})) }));
    const fakeModule: LangGraphModule = {
      StateGraph: { prototype: { compile: compileCall } }
    };

    await hooks.patchLangGraph({ agentId: "a1", loadModule: async () => fakeModule });
    const capturedCompile = fakeModule.StateGraph.prototype.compile;

    await hooks.patchLangGraph({ agentId: "a2", loadModule: async () => fakeModule });

    expect(fakeModule.StateGraph.prototype.compile).toBe(capturedCompile);
  });

  it("restores original compile when unpatch is called", async () => {
    const hooks = await import("../src/hooks/langgraph.js");

    const originalCompile = vi.fn(() => ({ invoke: vi.fn(async () => ({})), stream: vi.fn(async () => ({})) }));
    const fakeModule: LangGraphModule = {
      StateGraph: { prototype: { compile: originalCompile } }
    };

    await hooks.patchLangGraph({ agentId: "agent-3", loadModule: async () => fakeModule });
    expect(fakeModule.StateGraph.prototype.compile).not.toBe(originalCompile);

    const restored = hooks.unpatchLangGraph();
    expect(restored).toBe(true);
    expect(fakeModule.StateGraph.prototype.compile).toBe(originalCompile);
    expect(hooks.langGraphPatchState.isPatched).toBe(false);
  });

  it("returns false from unpatch when not patched", async () => {
    const hooks = await import("../src/hooks/langgraph.js");
    expect(hooks.unpatchLangGraph()).toBe(false);
  });

  it("propagates compile errors without swallowing them", async () => {
    const hooks = await import("../src/hooks/langgraph.js");

    const fakeModule: LangGraphModule = {
      StateGraph: {
        prototype: {
          compile: vi.fn(() => {
            throw new Error("compile-error");
          })
        }
      }
    };

    await hooks.patchLangGraph({ agentId: "agent-4", loadModule: async () => fakeModule });

    expect(() => fakeModule.StateGraph.prototype.compile!()).toThrow("compile-error");
  });

  it("returns unwrapped graph and logs warning when wrapCompiledGraph throws", async () => {
    const hooks = await import("../src/hooks/langgraph.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const badCompiled = {
      get invoke(): never {
        throw new Error("no invoke");
      },
      get stream(): never {
        throw new Error("no stream");
      }
    };

    const fakeModule: LangGraphModule = {
      StateGraph: {
        prototype: {
          compile: vi.fn(() => badCompiled as unknown as ReturnType<NonNullable<StateGraphClass["prototype"]["compile"]>>)
        }
      }
    };

    await hooks.patchLangGraph({ agentId: "agent-5", loadModule: async () => fakeModule });

    expect(() => fakeModule.StateGraph.prototype.compile!()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[assembly] LangGraph lineage patch error"),
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it("activates langgraph-js in activeAdapters during initAssembly when module detected", async () => {
    const fakeCompiled = {
      invoke: vi.fn(async () => ({})),
      stream: vi.fn(async () => ({}))
    };
    const fakeStateGraphClass: StateGraphClass = {
      prototype: { compile: vi.fn(() => fakeCompiled) }
    };

    vi.doMock("@langchain/langgraph", () => ({ StateGraph: fakeStateGraphClass }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: (packageName: string) => {
          if (packageName === "@langchain/langgraph") return packageName;
          throw new Error("MODULE_NOT_FOUND");
        }
      })
    }));

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      agentId: "agent-init-lg"
    });

    expect(context.activeAdapters).toContain("langgraph-js");
  });
});

async function resetPatchState(): Promise<void> {
  const hooks = await import("../src/hooks/langgraph.js");
  hooks.unpatchLangGraph();
  hooks.langGraphPatchState.originalCompile = undefined;
  hooks.langGraphPatchState.patchedClass = undefined;
  hooks.langGraphPatchState.isPatched = false;
}
