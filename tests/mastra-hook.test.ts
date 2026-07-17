import { afterEach, describe, expect, it, vi } from "vitest";
import type { MastraAgentClass, MastraModule, MastraWorkflowClass } from "../src/hooks/mastra.js";
import { REDACTED } from "../src/core/redact.js";

afterEach(() => {
  return resetPatchState().finally(() => {
    vi.resetModules();
    vi.unmock("@mastra/core");
  });
});

describe("mastra hook", () => {
  it("wraps Agent.prototype.generate with agent context", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const lineage = await import("../src/lineage/agent-context-store.js");

    const captured: string[] = [];
    const fakeAgentClass: MastraAgentClass = {
      prototype: {
        generate: vi.fn(async function () {
          captured.push(lineage.currentAgentId() ?? "none");
          return { text: "hello" };
        })
      }
    };
    const fakeModule: MastraModule = { Agent: fakeAgentClass };

    await hooks.patchMastra({ agentId: "agent-mastra-1", loadModule: async () => fakeModule });

    const instance = Object.create(fakeAgentClass.prototype);
    await fakeAgentClass.prototype.generate!.call(instance, "prompt");

    expect(captured).toEqual(["agent-mastra-1"]);
  });

  it("wraps Workflow.prototype.execute with agent context when present", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const lineage = await import("../src/lineage/agent-context-store.js");

    const captured: string[] = [];
    const fakeAgentClass: MastraAgentClass = {
      prototype: {
        generate: vi.fn(async () => ({}))
      }
    };
    const fakeWorkflowClass: MastraWorkflowClass = {
      prototype: {
        execute: vi.fn(async function () {
          captured.push(lineage.currentAgentId() ?? "none");
          return { status: "done" };
        })
      }
    };
    const fakeModule: MastraModule = { Agent: fakeAgentClass, Workflow: fakeWorkflowClass };

    await hooks.patchMastra({ agentId: "agent-mastra-2", loadModule: async () => fakeModule });

    const instance = Object.create(fakeWorkflowClass.prototype);
    await fakeWorkflowClass.prototype.execute!.call(instance, {});

    expect(captured).toEqual(["agent-mastra-2"]);
  });

  it("returns false when module is unavailable", async () => {
    const hooks = await import("../src/hooks/mastra.js");

    const patched = await hooks.patchMastra({
      agentId: "agent-1",
      loadModule: async () => undefined
    });

    expect(patched).toBe(false);
    expect(hooks.mastraPatchState.isPatched).toBe(false);
  });

  it("returns false when Agent.prototype.generate is absent", async () => {
    const hooks = await import("../src/hooks/mastra.js");

    const fakeModule: MastraModule = { Agent: { prototype: {} } };

    const patched = await hooks.patchMastra({
      agentId: "agent-2",
      loadModule: async () => fakeModule
    });

    expect(patched).toBe(false);
  });

  it("returns true without re-patching when already patched", async () => {
    const hooks = await import("../src/hooks/mastra.js");

    const fakeModule: MastraModule = {
      Agent: { prototype: { generate: vi.fn(async () => ({})) } }
    };

    await hooks.patchMastra({ agentId: "a1", loadModule: async () => fakeModule });
    const capturedGenerate = fakeModule.Agent.prototype.generate;

    await hooks.patchMastra({ agentId: "a2", loadModule: async () => fakeModule });

    expect(fakeModule.Agent.prototype.generate).toBe(capturedGenerate);
  });

  it("restores original generate and execute when unpatch is called", async () => {
    const hooks = await import("../src/hooks/mastra.js");

    const originalGenerate = vi.fn(async () => ({}));
    const originalExecute = vi.fn(async () => ({}));
    const fakeAgentClass: MastraAgentClass = { prototype: { generate: originalGenerate } };
    const fakeWorkflowClass: MastraWorkflowClass = { prototype: { execute: originalExecute } };
    const fakeModule: MastraModule = { Agent: fakeAgentClass, Workflow: fakeWorkflowClass };

    await hooks.patchMastra({ agentId: "agent-3", loadModule: async () => fakeModule });

    expect(fakeAgentClass.prototype.generate).not.toBe(originalGenerate);
    expect(fakeWorkflowClass.prototype.execute).not.toBe(originalExecute);

    const restored = hooks.unpatchMastra();
    expect(restored).toBe(true);
    expect(fakeAgentClass.prototype.generate).toBe(originalGenerate);
    expect(fakeWorkflowClass.prototype.execute).toBe(originalExecute);
    expect(hooks.mastraPatchState.isPatched).toBe(false);
  });

  it("returns false from unpatch when not patched", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    expect(hooks.unpatchMastra()).toBe(false);
  });

  it("falls back to original generate and logs warning when runWithAgentId throws", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const originalGenerate = vi.fn(async () => ({ text: "fallback" }));
    const fakeAgentClass: MastraAgentClass = { prototype: { generate: originalGenerate } };
    const fakeModule: MastraModule = { Agent: fakeAgentClass };

    const lineage = await import("../src/lineage/agent-context-store.js");
    vi.spyOn(lineage.agentContextStore, "run").mockImplementationOnce(() => {
      throw new Error("context-store-error");
    });

    await hooks.patchMastra({ agentId: "agent-4", loadModule: async () => fakeModule });

    const instance = Object.create(fakeAgentClass.prototype);
    const result = await fakeAgentClass.prototype.generate!.call(instance, "prompt");

    expect(result).toEqual({ text: "fallback" });
    expect(originalGenerate).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[assembly] Mastra lineage patch error on generate"),
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it("redacts a secret-looking token from the warn output when the lineage patch throws (AAASM-4741)", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const originalGenerate = vi.fn(async () => ({ text: "fallback" }));
    const fakeAgentClass: MastraAgentClass = { prototype: { generate: originalGenerate } };
    const fakeModule: MastraModule = { Agent: fakeAgentClass };

    const secretToken = "sk-SENTINELsupersecret1234567890";
    const lineage = await import("../src/lineage/agent-context-store.js");
    vi.spyOn(lineage.agentContextStore, "run").mockImplementationOnce(() => {
      throw new Error(`context store exploded: ${secretToken}`);
    });

    await hooks.patchMastra({ agentId: "agent-secret", loadModule: async () => fakeModule });

    const instance = Object.create(fakeAgentClass.prototype);
    await fakeAgentClass.prototype.generate!.call(instance, "prompt");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[assembly] Mastra lineage patch error on generate"),
      expect.stringContaining(REDACTED)
    );
    const loggedArgs = warnSpy.mock.calls[0] ?? [];
    expect(loggedArgs.join(" ")).not.toContain(secretToken);
    warnSpy.mockRestore();
  });

  it("returns false when the module loader throws", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const patched = await hooks.patchMastra({
      agentId: "agent-loader-throws",
      loadModule: async () => {
        throw new Error("module resolution exploded");
      }
    });
    expect(patched).toBe(false);
    expect(hooks.mastraPatchState.isPatched).toBe(false);
  });

  it("falls back to original execute and logs warning when runWithAgentId throws on a Workflow", async () => {
    const hooks = await import("../src/hooks/mastra.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const originalExecute = vi.fn(async () => ({ status: "fallback" }));
    const fakeAgentClass: MastraAgentClass = { prototype: { generate: vi.fn(async () => ({})) } };
    const fakeWorkflowClass: MastraWorkflowClass = { prototype: { execute: originalExecute } };
    const fakeModule: MastraModule = { Agent: fakeAgentClass, Workflow: fakeWorkflowClass };

    const lineage = await import("../src/lineage/agent-context-store.js");
    vi.spyOn(lineage.agentContextStore, "run").mockImplementationOnce(() => {
      throw new Error("context-store-error");
    });

    await hooks.patchMastra({ agentId: "agent-wf-fallback", loadModule: async () => fakeModule });

    const instance = Object.create(fakeWorkflowClass.prototype);
    const result = await fakeWorkflowClass.prototype.execute!.call(instance, {});

    expect(result).toEqual({ status: "fallback" });
    expect(originalExecute).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[assembly] Mastra lineage patch error on execute"),
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it("propagates a rejecting generate to the caller without re-invoking the original", async () => {
    const hooks = await import("../src/hooks/mastra.js");

    const originalGenerate = vi.fn(async () => {
      throw new Error("generate-failed");
    });
    const fakeAgentClass: MastraAgentClass = { prototype: { generate: originalGenerate } };
    const fakeModule: MastraModule = { Agent: fakeAgentClass };

    await hooks.patchMastra({ agentId: "agent-reject", loadModule: async () => fakeModule });

    const instance = Object.create(fakeAgentClass.prototype);
    await expect(fakeAgentClass.prototype.generate!.call(instance, "prompt")).rejects.toThrow(
      "generate-failed"
    );
    // The rejection surfaces to the caller; the fallback path must NOT run, so
    // the original is invoked exactly once (proves the promise is not awaited
    // inside the patch's try/catch).
    expect(originalGenerate).toHaveBeenCalledTimes(1);
  });

  it("activates mastra in activeAdapters during initAssembly when module detected", async () => {
    const fakeAgentClass: MastraAgentClass = {
      prototype: { generate: vi.fn(async () => ({})) }
    };

    vi.doMock("@mastra/core", () => ({ Agent: fakeAgentClass, Workflow: undefined }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: (packageName: string) => {
          if (packageName === "@mastra/core") return packageName;
          throw new Error("MODULE_NOT_FOUND");
        }
      })
    }));

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      agentId: "agent-init-mastra"
    });

    expect(context.activeAdapters).toContain("mastra");
  });
});

async function resetPatchState(): Promise<void> {
  const hooks = await import("../src/hooks/mastra.js");
  hooks.unpatchMastra();
  hooks.mastraPatchState.originalGenerate = undefined;
  hooks.mastraPatchState.originalExecute = undefined;
  hooks.mastraPatchState.patchedAgentClass = undefined;
  hooks.mastraPatchState.patchedWorkflowClass = undefined;
  hooks.mastraPatchState.isPatched = false;
}
