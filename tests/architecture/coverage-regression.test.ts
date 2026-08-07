import { describe, expect, it, vi } from "vitest";
import { PolicyViolationError } from "../../src/errors/index.js";

async function loadCoreWithInstalledPackages(installed: ReadonlySet<string>) {
  vi.resetModules();
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

  return import("../../src/core/init-assembly.js");
}

describe("coverage regression guards", () => {
  it("registerAdapters applies non-empty frameworks", async () => {
    const { registerAdapters } = await import("../../src/core/index.js");

    const adapters = await registerAdapters(["langchain-js"]);

    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.id).toBe("langchain-js");
  });

  it("initAssembly builds adapter states and shutdown iterates them", async () => {
    const { initAssembly } = await loadCoreWithInstalledPackages(new Set(["ai"]));

    const runtime = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only"
    });

    // `ai` resolves but is left unmocked, so the real frozen ES module namespace
    // rejects the governed `tool` factory and the patch warns-and-fails
    // (AAASM-4842). This case previously asserted `["vercel-ai-sdk"]` — i.e. it
    // pinned the AAASM-5664 defect, reporting a framework as active in the same
    // run that warned it was ungoverned. It is detected and unpatched, not active.
    expect(runtime.detectedAdapters).toEqual(["vercel-ai-sdk"]);
    expect(runtime.unpatchedAdapters).toEqual(["vercel-ai-sdk"]);
    expect(runtime.activeAdapters).toEqual([]);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it("exports PolicyViolationError with stable shape", () => {
    const error = new PolicyViolationError("blocked");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PolicyViolationError");
    expect(error.message).toBe("blocked");
  });

  it("loads type and adapter contract modules", async () => {
    const modules = await Promise.all([
      import("../../src/types/assembly-mode.js"),
      import("../../src/types/assembly-config.js"),
      import("../../src/types/assembly-context.js"),
      import("../../src/types/tool-map.js"),
      import("../../src/adapters/adapter.js"),
      import("../../src/adapters/adapter-registry.js"),
      import("../../src/gateway/client.js")
    ]);

    for (const module of modules) {
      expect(module).toBeDefined();
    }
  });
});
