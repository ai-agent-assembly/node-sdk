import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";

interface FakeAgentInstance {
  calls: number;
}

interface FakeAgentClass {
  prototype: {
    _runTool: (
      this: FakeAgentInstance,
      toolCall: { function: { name: string; arguments: string } },
      context: { runId?: string; agentId?: string }
    ) => Promise<Record<string, unknown>>;
  };
}

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
    vi.unmock("@openai/agents");
  });
});

describe("openai agents adapter", () => {
  it("activates patching during initAssembly when @openai/agents is detected", async () => {
    const gateway = createGatewayClientMock();
    const fakeAgentClass: FakeAgentClass = {
      prototype: {
        _runTool: vi.fn(async function (this: FakeAgentInstance) {
          this.calls += 1;
          return { ok: true };
        })
      }
    };

    vi.doMock("@openai/agents", () => ({ Agent: fakeAgentClass }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: (packageName: string) => {
          if (packageName === "@openai/agents") {
            return packageName;
          }
          throw new Error("MODULE_NOT_FOUND");
        }
      })
    }));

    const { initAssembly } = await import("../src/core/init-assembly.js");
    await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      gatewayClient: gateway
    });

    const hooks = await import("../src/hooks/openai-agents.js");
    expect(hooks.openAIAgentsPatchState.isPatched).toBe(true);
    expect(fakeAgentClass.prototype._runTool).not.toBe(
      hooks.openAIAgentsPatchState.originalRunTool
    );
  });

  it("returns error output on DENY without throwing or executing original tool", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "policy-blocked" }));
    const originalRunTool = vi.fn(async () => ({ ok: true }));

    const hooks = await import("../src/hooks/openai-agents.js");
    const patchedRunTool = hooks.createPatchedRunTool(originalRunTool, gateway, {
      fallbackRunId: "fallback-run",
      approvalTimeoutMs: 5_000
    });

    const result = await patchedRunTool(
      {
        function: {
          name: "send_email",
          arguments: "{\"to\":\"user@example.com\"}"
        }
      },
      {
        runId: "run-1",
        agentId: "agent-1"
      }
    );

    expect(result).toEqual({
      error: "Blocked by governance policy: policy-blocked"
    });
    expect(originalRunTool).not.toHaveBeenCalled();
  });

  it("executes original tool on ALLOW decision", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));
    const originalRunTool = vi.fn(async () => ({ ok: "allow-path" }));

    const hooks = await import("../src/hooks/openai-agents.js");
    const patchedRunTool = hooks.createPatchedRunTool(originalRunTool, gateway, {
      fallbackRunId: "fallback-run",
      approvalTimeoutMs: 5_000
    });

    const result = await patchedRunTool(
      {
        function: {
          name: "safe_tool",
          arguments: "{\"count\":1}"
        }
      },
      {
        runId: "run-allow"
      }
    );

    expect(result).toEqual({ ok: "allow-path" });
    expect(gateway.check).toHaveBeenCalledWith({
      action: "tool_call",
      toolName: "safe_tool",
      args: { count: 1 },
      runId: "run-allow"
    });
    expect(originalRunTool).toHaveBeenCalledTimes(1);
  });

  it("continues execution when PENDING is approved", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ pending: true, denied: false }));
    gateway.waitForApproval = vi.fn(async () => ({ denied: false }));
    const originalRunTool = vi.fn(async () => ({ ok: "approved" }));

    const hooks = await import("../src/hooks/openai-agents.js");
    const patchedRunTool = hooks.createPatchedRunTool(originalRunTool, gateway, {
      fallbackRunId: "fallback-run",
      approvalTimeoutMs: 8_000
    });

    const result = await patchedRunTool(
      {
        function: {
          name: "transfer_funds",
          arguments: "{\"amount\":100}"
        }
      },
      {
        runId: "run-2"
      }
    );

    expect(result).toEqual({ ok: "approved" });
    expect(gateway.waitForApproval).toHaveBeenCalledWith(
      "transfer_funds",
      "run-2",
      8_000
    );
    expect(originalRunTool).toHaveBeenCalledTimes(1);
  });

  it("returns approval error output when PENDING is denied", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ pending: true, denied: false }));
    gateway.waitForApproval = vi.fn(async () => ({
      denied: true,
      reason: "manual reviewer rejected"
    }));
    const originalRunTool = vi.fn(async () => ({ ok: true }));

    const hooks = await import("../src/hooks/openai-agents.js");
    const patchedRunTool = hooks.createPatchedRunTool(originalRunTool, gateway, {
      fallbackRunId: "fallback-run",
      approvalTimeoutMs: 1_000
    });

    const result = await patchedRunTool(
      {
        function: {
          name: "delete_account",
          arguments: "{\"id\":\"u1\"}"
        }
      },
      {
        runId: "run-3"
      }
    );

    expect(result).toEqual({
      error: "Approval denied: manual reviewer rejected"
    });
    expect(originalRunTool).not.toHaveBeenCalled();
  });

  it("falls back to raw argument string when JSON parsing fails", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));
    const originalRunTool = vi.fn(async () => ({ ok: true }));

    const hooks = await import("../src/hooks/openai-agents.js");
    const patchedRunTool = hooks.createPatchedRunTool(originalRunTool, gateway, {
      fallbackRunId: "fallback-run",
      approvalTimeoutMs: 2_000
    });

    await patchedRunTool(
      {
        function: {
          name: "malformed_payload_tool",
          arguments: "{bad-json"
        }
      },
      {
        runId: "run-4"
      }
    );

    expect(gateway.check).toHaveBeenCalledWith({
      action: "tool_call",
      toolName: "malformed_payload_tool",
      args: "{bad-json",
      runId: "run-4"
    });
  });

  it("extracts agentId and runId from context with optional chaining", async () => {
    const hooks = await import("../src/hooks/openai-agents.js");

    expect(
      hooks.extractToolCallContextMetadata({
        agentId: "agent-42",
        runId: "run-42"
      })
    ).toEqual({
      agentId: "agent-42",
      runId: "run-42"
    });

    expect(hooks.extractToolCallContextMetadata(undefined)).toEqual({
      agentId: undefined,
      runId: undefined
    });
  });

  it("records results in fire-and-forget mode without surfacing recorder failures", async () => {
    const gateway = createGatewayClientMock();
    gateway.recordResult = vi.fn(async () => {
      throw new Error("recording failed");
    });
    const hooks = await import("../src/hooks/openai-agents.js");

    expect(() =>
      hooks.recordToolResultNonBlocking(gateway, "run-5", { ok: true })
    ).not.toThrow();

    await Promise.resolve();
    expect(gateway.recordResult).toHaveBeenCalledWith({
      runId: "run-5",
      output: { ok: true }
    });
  });

  it("propagates the fault and blocks the tool when gateway check throws", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const originalRunTool = vi.fn(async () => ({ ok: "fallback-path" }));

    const hooks = await import("../src/hooks/openai-agents.js");
    const patchedRunTool = hooks.createPatchedRunTool(originalRunTool, gateway, {
      fallbackRunId: "fallback-run",
      approvalTimeoutMs: 4_000
    });

    const error = await patchedRunTool(
      {
        function: {
          name: "critical_tool",
          arguments: "{\"x\":1}"
        }
      },
      {
        runId: "run-6"
      }
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("gateway unavailable");
    expect(originalRunTool).not.toHaveBeenCalled();
  });

  it("propagates the fault and blocks the tool when approval handling throws on PENDING", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ pending: true, denied: false }));
    gateway.waitForApproval = vi.fn(async () => {
      throw new Error("approval channel unavailable");
    });
    const originalRunTool = vi.fn(async () => ({ ok: "approval-fail-open" }));

    const hooks = await import("../src/hooks/openai-agents.js");
    const patchedRunTool = hooks.createPatchedRunTool(originalRunTool, gateway, {
      fallbackRunId: "fallback-run",
      approvalTimeoutMs: 2_000
    });

    const error = await patchedRunTool(
      { function: { name: "pending_tool", arguments: "{}" } },
      { runId: "run-pending-throw" }
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("approval channel unavailable");
    expect(originalRunTool).not.toHaveBeenCalled();
  });

  it("returns true without re-patching when already patched", async () => {
    const gateway = createGatewayClientMock();
    const fakeAgentClass: FakeAgentClass = {
      prototype: { _runTool: vi.fn(async () => ({ ok: true })) }
    };

    const hooks = await import("../src/hooks/openai-agents.js");
    expect(
      await hooks.patchOpenAIAgents({ gatewayClient: gateway, loadAgentClass: async () => fakeAgentClass })
    ).toBe(true);
    const patchedRunTool = fakeAgentClass.prototype._runTool;

    expect(
      await hooks.patchOpenAIAgents({ gatewayClient: gateway, loadAgentClass: async () => fakeAgentClass })
    ).toBe(true);
    expect(fakeAgentClass.prototype._runTool).toBe(patchedRunTool);
  });

  it("returns false when the agent-class loader yields nothing", async () => {
    const gateway = createGatewayClientMock();
    const hooks = await import("../src/hooks/openai-agents.js");
    expect(
      await hooks.patchOpenAIAgents({ gatewayClient: gateway, loadAgentClass: async () => undefined })
    ).toBe(false);
    expect(hooks.openAIAgentsPatchState.isPatched).toBe(false);
  });

  it("returns false when the agent class exposes no _runTool method", async () => {
    const gateway = createGatewayClientMock();
    // captureOriginalRunTool returns undefined → patch aborts before mutating.
    const fakeAgentClass = { prototype: {} } as unknown as FakeAgentClass;
    const hooks = await import("../src/hooks/openai-agents.js");
    expect(
      await hooks.patchOpenAIAgents({ gatewayClient: gateway, loadAgentClass: async () => fakeAgentClass })
    ).toBe(false);
    expect(hooks.openAIAgentsPatchState.isPatched).toBe(false);
  });

  it("restores original _runTool when unpatch is called", async () => {
    const gateway = createGatewayClientMock();
    const originalRunTool = vi.fn(async () => ({ ok: true }));
    const fakeAgentClass: FakeAgentClass = {
      prototype: {
        _runTool: originalRunTool
      }
    };

    const hooks = await import("../src/hooks/openai-agents.js");
    const patched = await hooks.patchOpenAIAgents({
      gatewayClient: gateway,
      loadAgentClass: async () => fakeAgentClass
    });

    expect(patched).toBe(true);
    expect(fakeAgentClass.prototype._runTool).not.toBe(originalRunTool);

    const restored = hooks.unpatchOpenAIAgents();
    expect(restored).toBe(true);
    expect(fakeAgentClass.prototype._runTool).toBe(originalRunTool);
  });
});
async function resetPatchState() {
  const hooks = await import("../src/hooks/openai-agents.js");
  hooks.unpatchOpenAIAgents();
  hooks.openAIAgentsPatchState.originalRunTool = undefined;
  hooks.openAIAgentsPatchState.patchedAgentClass = undefined;
  hooks.openAIAgentsPatchState.isPatched = false;
}
