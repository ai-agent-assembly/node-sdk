import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { LangChainToolLike } from "../src/types/langchain-adapter.js";

function createGatewayMock(): GatewayClient {
  return {
    mode: "sdk-only",
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    check: vi.fn(async () => ({ denied: true, reason: "blocked by policy" })),
    waitForApproval: vi.fn(async () => ({ denied: false })),
    record: vi.fn(async () => undefined),
    recordResult: vi.fn(async () => undefined),
    scanPrompts: vi.fn(async () => undefined)
  };
}

async function loadInitAssemblyWithInstalledPackages(installed: ReadonlySet<string>) {
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

  return import("../src/core/init-assembly.js");
}

function createTool(name: string): LangChainToolLike {
  return {
    name,
    invoke: vi.fn(async () => `${name}-ok`)
  };
}

describe("initAssembly LangChain integration", () => {
  it("auto-registers callback handler and wraps all configured tools", async () => {
    const gateway = createGatewayMock();
    const callbacks: { name: string }[] = [];
    const firstTool = createTool("send_email");
    const secondTool = createTool("search_web");

    const { initAssembly } = await loadInitAssemblyWithInstalledPackages(new Set(["@langchain/core"]));

    const runtime = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: gateway,
      langchain: {
        callbacks,
        tools: {
          sendEmail: firstTool,
          searchWeb: secondTool
        },
        approvalTimeoutMs: 100
      }
    });

    expect(runtime.activeAdapters).toContain("langchain-js");
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.name).toBe("assembly_handler");

    await expect(firstTool.invoke({ to: "user@example.com" })).rejects.toThrow("send_email");
    await expect(secondTool.invoke({ q: "query" })).rejects.toThrow("search_web");

    await runtime.shutdown();
  });

  it("skips a frozen tool with a warning without aborting wrapping of the rest", async () => {
    // AAASM-4852: one frozen tool must not abort the init wrapping loop. The
    // frozen tool is skipped + warned (runs ungoverned, its original invoke
    // returns), while every subsequent writable tool is still wrapped and
    // governed. Without the guard, the throw would abort the loop and leave the
    // later tools ungoverned too.
    const gateway = createGatewayMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const frozenTool = Object.freeze(createTool("frozen_send"));
    const writableTool = createTool("search_web");

    const { initAssembly } = await loadInitAssemblyWithInstalledPackages(new Set(["@langchain/core"]));

    const runtime = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: gateway,
      langchain: {
        tools: {
          frozenSend: frozenTool,
          searchWeb: writableTool
        }
      }
    });

    try {
      // The frozen tool was skipped: it runs ungoverned (original invoke), and a
      // warning naming it was emitted.
      await expect(frozenTool.invoke({ to: "user@example.com" })).resolves.toBe("frozen_send-ok");
      const warned = stderr.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("frozen_send") && line.includes("AAASM-4852"));
      expect(warned).toBe(true);

      // The later writable tool is still governed despite the earlier frozen one.
      await expect(writableTool.invoke({ q: "query" })).rejects.toThrow("search_web");
    } finally {
      stderr.mockRestore();
      await runtime.shutdown();
    }
  });

  it("propagates policy violation cleanly from wrapped tool invoke", async () => {
    const gateway = createGatewayMock();
    const blockedTool = createTool("transfer_funds");

    const { initAssembly } = await loadInitAssemblyWithInstalledPackages(new Set(["@langchain/core"]));

    await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: gateway,
      langchain: {
        tools: { transferFunds: blockedTool }
      }
    });

    await expect(blockedTool.invoke({ amount: 1000 })).rejects.toThrow("transfer_funds");
  });
});
