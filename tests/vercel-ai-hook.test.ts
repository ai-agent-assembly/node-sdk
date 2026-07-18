import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { VercelAiToolDefinition, VercelAiToolFactory } from "../src/types/vercel-ai-adapter.js";
import type { VercelAiSdkModule } from "../src/hooks/ai-sdk.js";

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

afterEach(() => {
  return resetPatchState().finally(() => {
    vi.resetModules();
  });
});

describe("vercel ai sdk adapter", () => {
  it("executes original tool on ALLOW decision", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));
    const originalExecute = vi.fn(async () => ({ ok: "allow-path" }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "a weather tool",
      gateway,
      { approvalTimeoutMs: 5_000, fallbackRunId: "fallback" }
    );

    const result = await wrappedExecute(
      { city: "Tokyo" },
      { toolCallId: "call-1" }
    );

    expect(result).toEqual({ ok: "allow-path" });
    expect(gateway.check).toHaveBeenCalledWith({
      action: "tool_call",
      toolName: "a weather tool",
      args: { city: "Tokyo" },
      runId: "call-1"
    });
    expect(originalExecute).toHaveBeenCalledTimes(1);
  });

  it("throws PolicyViolationError on DENY without executing original tool", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "policy-blocked" }));
    const originalExecute = vi.fn(async () => ({ ok: true }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "send email tool",
      gateway,
      { approvalTimeoutMs: 5_000, fallbackRunId: "fallback" }
    );

    const error = await wrappedExecute(
      { to: "user@example.com" },
      { toolCallId: "call-2" }
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("PolicyViolationError");
    expect((error as Error).message).toBe(
      "Tool blocked by governance policy: policy-blocked"
    );

    expect(originalExecute).not.toHaveBeenCalled();
  });

  it("continues execution when PENDING is approved", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ pending: true, denied: false }));
    gateway.waitForApproval = vi.fn(async () => ({ denied: false }));
    const originalExecute = vi.fn(async () => ({ ok: "approved" }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "transfer funds",
      gateway,
      { approvalTimeoutMs: 8_000, fallbackRunId: "fallback" }
    );

    const result = await wrappedExecute(
      { amount: 100 },
      { toolCallId: "call-3" }
    );

    expect(result).toEqual({ ok: "approved" });
    expect(gateway.waitForApproval).toHaveBeenCalledWith(
      "transfer funds",
      "call-3",
      8_000
    );
    expect(originalExecute).toHaveBeenCalledTimes(1);
  });

  it("throws PolicyViolationError when PENDING is denied", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ pending: true, denied: false }));
    gateway.waitForApproval = vi.fn(async () => ({
      denied: true,
      reason: "manual reviewer rejected"
    }));
    const originalExecute = vi.fn(async () => ({ ok: true }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "delete account",
      gateway,
      { approvalTimeoutMs: 1_000, fallbackRunId: "fallback" }
    );

    const error = await wrappedExecute(
      { id: "u1" },
      { toolCallId: "call-4" }
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("PolicyViolationError");
    expect((error as Error).message).toBe(
      "Approval rejected: manual reviewer rejected"
    );

    expect(originalExecute).not.toHaveBeenCalled();
  });

  it("uses description for toolName in gateway check", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));
    const originalExecute = vi.fn(async () => ({ ok: true }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "Get current weather for a city",
      gateway,
      { approvalTimeoutMs: 5_000, fallbackRunId: "fallback" }
    );

    await wrappedExecute({ city: "Paris" }, { toolCallId: "call-5" });

    expect(gateway.check).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "Get current weather for a city"
      })
    );
  });

  it("propagates the fault and blocks the tool when gateway check throws", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const originalExecute = vi.fn(async () => ({ ok: "fallback-path" }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "critical tool",
      gateway,
      { approvalTimeoutMs: 4_000, fallbackRunId: "fallback" }
    );

    const error = await wrappedExecute(
      { x: 1 },
      { toolCallId: "call-6" }
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("gateway unavailable");
    expect(originalExecute).not.toHaveBeenCalled();
  });

  it("records results in fire-and-forget mode without surfacing recorder failures", async () => {
    const gateway = createGatewayClientMock();
    gateway.recordResult = vi.fn(async () => {
      throw new Error("recording failed");
    });
    const hooks = await import("../src/hooks/ai-sdk.js");

    expect(() =>
      hooks.recordToolResultNonBlocking(gateway, "run-7", { ok: true })
    ).not.toThrow();

    await Promise.resolve();
    expect(gateway.recordResult).toHaveBeenCalledWith({
      runId: "run-7",
      output: { ok: true }
    });
  });

  it("uses fallbackRunId when toolCallId is not provided", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));
    const originalExecute = vi.fn(async () => ({ ok: true }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "some tool",
      gateway,
      { approvalTimeoutMs: 5_000, fallbackRunId: "vercel-ai-sdk" }
    );

    await wrappedExecute({ data: "test" }, {});

    expect(gateway.check).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "vercel-ai-sdk"
      })
    );
  });

  it("restores original tool factory when unpatch is called", async () => {
    const gateway = createGatewayClientMock();
    const originalTool = vi.fn((def: VercelAiToolDefinition) => def) as unknown as VercelAiToolFactory;
    const fakeModule: VercelAiSdkModule = { tool: originalTool };

    const hooks = await import("../src/hooks/ai-sdk.js");
    const patched = await hooks.patchVercelAiSdk({
      gatewayClient: gateway,
      loadModule: async () => fakeModule
    });

    expect(patched).toBe(true);
    expect(fakeModule.tool).not.toBe(originalTool);

    const restored = hooks.unpatchVercelAiSdk();
    expect(restored).toBe(true);
    expect(fakeModule.tool).toBe(originalTool);
  });

  it("propagates the fault and blocks the tool when approval-wait throws on PENDING", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ pending: true, denied: false }));
    gateway.waitForApproval = vi.fn(async () => {
      throw new Error("approval channel unavailable");
    });
    const originalExecute = vi.fn(async () => ({ ok: "approval-fail-open" }));

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "pending tool",
      gateway,
      { approvalTimeoutMs: 2_000, fallbackRunId: "fallback" }
    );

    const error = await wrappedExecute({ x: 1 }, { toolCallId: "call-pending-throw" }).catch(
      (e: Error) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("approval channel unavailable");
    expect(originalExecute).not.toHaveBeenCalled();
  });

  it("returns true without re-patching when patchVercelAiSdk is already patched", async () => {
    const gateway = createGatewayClientMock();
    const originalTool = vi.fn((def: VercelAiToolDefinition) => def) as unknown as VercelAiToolFactory;
    const fakeModule: VercelAiSdkModule = { tool: originalTool };

    const hooks = await import("../src/hooks/ai-sdk.js");
    expect(await hooks.patchVercelAiSdk({ gatewayClient: gateway, loadModule: async () => fakeModule })).toBe(true);

    const secondModule: VercelAiSdkModule = { tool: originalTool };
    // Second call short-circuits: returns true and does not touch the new module.
    expect(await hooks.patchVercelAiSdk({ gatewayClient: gateway, loadModule: async () => secondModule })).toBe(true);
    expect(secondModule.tool).toBe(originalTool);
  });

  it("returns false when the module loader yields nothing", async () => {
    const gateway = createGatewayClientMock();
    const hooks = await import("../src/hooks/ai-sdk.js");
    expect(
      await hooks.patchVercelAiSdk({ gatewayClient: gateway, loadModule: async () => undefined })
    ).toBe(false);
    expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
  });

  it("defaults the gateway toolName to 'unknown_tool' when a tool has no description", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));
    const originalExecute = vi.fn(async () => ({ ok: true }));
    // A tool with execute but no description exercises the `?? "unknown_tool"` fallback.
    const originalTool = vi.fn((def: VercelAiToolDefinition) => ({
      ...def,
      execute: originalExecute,
    })) as unknown as VercelAiToolFactory;
    const fakeModule: VercelAiSdkModule = { tool: originalTool };

    const hooks = await import("../src/hooks/ai-sdk.js");
    await hooks.patchVercelAiSdk({ gatewayClient: gateway, loadModule: async () => fakeModule });

    const wrapped = fakeModule.tool({ parameters: {} } as VercelAiToolDefinition);
    await wrapped.execute!({}, { toolCallId: "call-nodesc" });

    expect(gateway.check).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "unknown_tool" })
    );
  });

  it("warns loudly and returns false when ai is installed but the tool factory is missing", async () => {
    const gateway = createGatewayClientMock();
    // `ai` loaded but module.tool is not a function → the AAASM-4805
    // upstream-API-moved case (captureOriginalToolFactory returns undefined).
    const fakeModule = { tool: undefined } as unknown as VercelAiSdkModule;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      // No failClosed (observe/disabled posture): warn, do not throw.
      expect(
        await hooks.patchVercelAiSdk({ gatewayClient: gateway, loadModule: async () => fakeModule })
      ).toBe(false);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      const warning = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(warning).toContain("[agent-assembly] WARNING");
      expect(warning).toContain('"tool"');
      expect(warning).toContain("AAASM-4805");
    } finally {
      stderr.mockRestore();
    }
  });

  it("throws ConfigurationError under fail-closed when ai is installed but the tool factory is missing", async () => {
    const gateway = createGatewayClientMock();
    const fakeModule = { tool: undefined } as unknown as VercelAiSdkModule;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      await expect(
        hooks.patchVercelAiSdk({
          gatewayClient: gateway,
          failClosed: true,
          loadModule: async () => fakeModule
        })
      ).rejects.toThrow(/cannot govern Vercel AI SDK tool calls/);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      // Loud warning still emitted before the throw.
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("warns loudly and returns false when ai is a frozen ESM namespace (governed factory not written back)", async () => {
    const gateway = createGatewayClientMock();
    const originalTool = vi.fn((def: VercelAiToolDefinition) => def) as unknown as VercelAiToolFactory;
    // Object.freeze reproduces a real `ai` ES module namespace: its `tool` export
    // is non-writable, so applyGovernedToolFactory cannot write the governed
    // factory back (AAASM-4842) — the shim it lands in is inert.
    const frozenModule: VercelAiSdkModule = Object.freeze({ tool: originalTool });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      // No failClosed (observe/disabled posture): warn, do not throw, do not report success.
      expect(
        await hooks.patchVercelAiSdk({ gatewayClient: gateway, loadModule: async () => frozenModule })
      ).toBe(false);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      // The frozen namespace is left untouched — the app's `tool` stays the original.
      expect(frozenModule.tool).toBe(originalTool);
      const warning = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(warning).toContain("[agent-assembly] WARNING");
      expect(warning).toContain("frozen");
      expect(warning).toContain("AAASM-4842");
    } finally {
      stderr.mockRestore();
    }
  });

  it("throws ConfigurationError on a frozen ESM namespace only when throwOnFrozenInert is set", async () => {
    const gateway = createGatewayClientMock();
    const originalTool = vi.fn((def: VercelAiToolDefinition) => def) as unknown as VercelAiToolFactory;
    const frozenModule: VercelAiSdkModule = Object.freeze({ tool: originalTool });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      // throwOnFrozenInert is the direct/explicit hard-enforcement opt-in.
      await expect(
        hooks.patchVercelAiSdk({
          gatewayClient: gateway,
          throwOnFrozenInert: true,
          loadModule: async () => frozenModule
        })
      ).rejects.toThrow(/frozen ES module/);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      expect(frozenModule.tool).toBe(originalTool);
      // Loud warning still emitted before the throw.
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("does NOT throw on a frozen ESM namespace under failClosed alone (AAASM-1847 / 4769: auto-detect stays zero-config)", async () => {
    const gateway = createGatewayClientMock();
    const originalTool = vi.fn((def: VercelAiToolDefinition) => def) as unknown as VercelAiToolFactory;
    const frozenModule: VercelAiSdkModule = Object.freeze({ tool: originalTool });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      // `failClosed` gates the AAASM-4805 moved-hook throw ONLY; the frozen path
      // (the shape of every real `ai`) must warn, not hard-fail init — otherwise
      // any enforce user with `ai` installed would break zero-config.
      expect(
        await hooks.patchVercelAiSdk({
          gatewayClient: gateway,
          failClosed: true,
          loadModule: async () => frozenModule
        })
      ).toBe(false);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      const warning = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(warning).toContain("AAASM-4842");
    } finally {
      stderr.mockRestore();
    }
  });

  it("patches a WRITABLE module silently-successfully (no warning, no throw)", async () => {
    const gateway = createGatewayClientMock();
    const originalTool = vi.fn((def: VercelAiToolDefinition) => def) as unknown as VercelAiToolFactory;
    // A writable plain object (dev/test shape) is mutated in place, so governance
    // is genuinely installed — this path must stay quiet and report success.
    const writableModule: VercelAiSdkModule = { tool: originalTool };
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      expect(
        await hooks.patchVercelAiSdk({
          gatewayClient: gateway,
          failClosed: true,
          loadModule: async () => writableModule
        })
      ).toBe(true);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(true);
      expect(writableModule.tool).not.toBe(originalTool);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("stays a silent no-op (no warn, no throw) when ai is not installed even under fail-closed", async () => {
    const gateway = createGatewayClientMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      // loadModule yields undefined → `ai` absent → zero-config silent no-op,
      // even with failClosed set: absence is not a moved hook point (AAASM-4805).
      expect(
        await hooks.patchVercelAiSdk({
          gatewayClient: gateway,
          failClosed: true,
          loadModule: async () => undefined
        })
      ).toBe(false);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("unpatch returns false when nothing is patched", async () => {
    const hooks = await import("../src/hooks/ai-sdk.js");
    expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
    expect(hooks.unpatchVercelAiSdk()).toBe(false);
  });

  it("passes through tools without execute unchanged", async () => {
    const gateway = createGatewayClientMock();
    const toolWithoutExecute: VercelAiToolDefinition = { description: "a schema-only tool", parameters: {} };
    const originalTool = vi.fn((def: VercelAiToolDefinition) => ({ ...def })) as unknown as VercelAiToolFactory;
    const fakeModule: VercelAiSdkModule = { tool: originalTool };

    const hooks = await import("../src/hooks/ai-sdk.js");
    await hooks.patchVercelAiSdk({
      gatewayClient: gateway,
      loadModule: async () => fakeModule
    });

    const result = fakeModule.tool(toolWithoutExecute);
    expect(result.execute).toBeUndefined();
    expect(result.description).toBe("a schema-only tool");
  });

  it("sets agent context store during tool execution when agentId is provided", async () => {
    const gateway = createGatewayClientMock();
    const lineage = await import("../src/lineage/agent-context-store.js");
    const captured: string[] = [];

    const originalExecute = vi.fn(async () => {
      captured.push(lineage.currentAgentId() ?? "none");
      return { ok: true };
    });

    const hooks = await import("../src/hooks/ai-sdk.js");
    const wrappedExecute = hooks.createWrappedExecute(
      originalExecute,
      "spawn tool",
      gateway,
      { approvalTimeoutMs: 5_000, fallbackRunId: "fallback", agentId: "agent-vercel-1" }
    );

    await wrappedExecute({ x: 1 }, { toolCallId: "call-lineage" });

    expect(captured).toEqual(["agent-vercel-1"]);
  });

  it("activates patching during initAssembly when ai package is detected", async () => {
    const gateway = createGatewayClientMock();
    const originalTool = vi.fn((def: VercelAiToolDefinition) => def) as unknown as VercelAiToolFactory;

    vi.doMock("ai", () => ({ tool: originalTool }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: (packageName: string) => {
          if (packageName === "ai") {
            return packageName;
          }
          throw new Error("MODULE_NOT_FOUND");
        }
      })
    }));

    const { initAssembly } = await import("../src/core/init-assembly.js");
    const context = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: gateway
    });

    expect(context.activeAdapters).toContain("vercel-ai-sdk");

    const hooks = await import("../src/hooks/ai-sdk.js");
    expect(hooks.vercelAiSdkPatchState.isPatched).toBe(true);
  });
});

async function resetPatchState(): Promise<void> {
  const hooks = await import("../src/hooks/ai-sdk.js");
  hooks.unpatchVercelAiSdk();
  hooks.vercelAiSdkPatchState.originalToolFactory = undefined;
  hooks.vercelAiSdkPatchState.patchedModule = undefined;
  hooks.vercelAiSdkPatchState.isPatched = false;
  hooks.vercelAiSdkPatchState.mutatedOriginal = false;
}
