import { describe, expect, it, vi } from "vitest";
import { wrapToolWithAssembly } from "../src/adapters/langchain/index.js";
import { PolicyViolationError } from "../src/errors/index.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { LangChainToolLike } from "../src/types/langchain-adapter.js";

function createGatewayMock(): GatewayClient {
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

function createTool(): LangChainToolLike {
  return {
    name: "send_email",
    invoke: vi.fn(async () => "tool-result")
  };
}

describe("wrapToolWithAssembly", () => {
  it("blocks tool invocation when gateway check returns DENY", async () => {
    const gateway = createGatewayMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "no outbound email" }));

    const tool = createTool();
    const invokeSpy = tool.invoke as ReturnType<typeof vi.fn>;

    wrapToolWithAssembly(tool, gateway, {
      generateRunId: () => "run-deny"
    });

    await expect(tool.invoke({ to: "bob@example.com" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("allows tool invocation after PENDING decision is approved", async () => {
    const gateway = createGatewayMock();
    gateway.check = vi.fn(async () => ({ pending: true }));
    gateway.waitForApproval = vi.fn(async () => ({ denied: false }));

    const tool = createTool();
    const invokeSpy = tool.invoke as ReturnType<typeof vi.fn>;

    wrapToolWithAssembly(tool, gateway, {
      generateRunId: () => "run-approved",
      approvalTimeoutMs: 100
    });

    await expect(tool.invoke({ to: "carol@example.com" })).resolves.toBe("tool-result");
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it("throws PolicyViolationError when PENDING approval is rejected", async () => {
    const gateway = createGatewayMock();
    gateway.check = vi.fn(async () => ({ pending: true }));
    gateway.waitForApproval = vi.fn(async () => ({ denied: true, reason: "manager rejected" }));

    const tool = createTool();
    const invokeSpy = tool.invoke as ReturnType<typeof vi.fn>;

    wrapToolWithAssembly(tool, gateway, {
      generateRunId: () => "run-rejected",
      approvalTimeoutMs: 100
    });

    await expect(tool.invoke({ to: "dave@example.com" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("guards a frozen tool: warns and returns without throwing, leaving invoke unwrapped", async () => {
    // AAASM-4852: a frozen tool makes the `tool.invoke = …` assignment throw in
    // strict mode. The wrapper is LangChain's only blocking enforcement point,
    // so it must skip + warn rather than throw (which would abort the init
    // wrapping loop). The original invoke stays in place (ungoverned, loudly).
    const gateway = createGatewayMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const tool = Object.freeze(createTool());
    const originalInvoke = tool.invoke;

    try {
      expect(() => wrapToolWithAssembly(tool, gateway, {})).not.toThrow();
      expect(tool.invoke).toBe(originalInvoke);

      const warned = stderr.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("send_email") && line.includes("AAASM-4852"));
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("wraps a sealed-but-writable tool: enforcement is applied (AAASM-4951)", async () => {
    // AAASM-4951: `Object.seal()` sets extensible:false but leaves the existing
    // `invoke` data property writable:true, so `tool.invoke = wrapper` succeeds.
    // The guard must not skip on non-extensibility alone — doing so silently
    // downgraded enforcement on a seam the assignment would have taken.
    const gateway = createGatewayMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "sealed but governed" }));

    const tool = Object.seal(createTool());
    const originalInvoke = tool.invoke;

    expect(Object.isExtensible(tool)).toBe(false);
    expect(() => wrapToolWithAssembly(tool, gateway, { generateRunId: () => "run-sealed" })).not.toThrow();
    // The seam was actually replaced with the governed wrapper.
    expect(tool.invoke).not.toBe(originalInvoke);
    await expect(tool.invoke({ to: "eve@example.com" })).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it("guards a tool whose invoke slot is non-writable: warns without throwing", async () => {
    // AAASM-4852: extensible object, but its `invoke` is a non-writable data
    // property — the assignment still throws. Exercises the descriptor branch of
    // the writability guard that a fully frozen object short-circuits before.
    const gateway = createGatewayMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const tool = createTool();
    Object.defineProperty(tool, "invoke", {
      value: tool.invoke,
      writable: false,
      configurable: true,
      enumerable: true
    });
    expect(Object.isExtensible(tool)).toBe(true);

    try {
      expect(() => wrapToolWithAssembly(tool, gateway, {})).not.toThrow();
      const warned = stderr.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("send_email") && line.includes("AAASM-4852"));
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});
