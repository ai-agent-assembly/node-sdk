import { DynamicTool } from "@langchain/core/tools";
import { describe, expect, it, vi } from "vitest";
import { AssemblyCallbackHandler, wrapToolWithAssembly } from "../src/adapters/langchain/index.js";
import { PolicyViolationError } from "../src/errors/index.js";
import type { GatewayClient } from "../src/gateway/client.js";

function createDenyingGatewayMock(): GatewayClient {
  return {
    mode: "sdk-only",
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    check: vi.fn(async () => ({ denied: true, reason: "blocked-by-policy" })),
    waitForApproval: vi.fn(async () => ({ denied: false })),
    record: vi.fn(async () => undefined),
    recordResult: vi.fn(async () => undefined),
    scanPrompts: vi.fn(async () => undefined)
  };
}

// AAASM-4799: AssemblyCallbackHandler.handleToolEnd used to return a
// BLOCKED_OUTPUT sentinel meant to redact a denied tool's output, but
// @langchain/core's real tool invocation awaits a callback handler's
// handleToolEnd and discards its return value - the caller always gets the
// tool's real output regardless. These tests exercise real @langchain/core
// (not a hand-rolled callback manager stand-in) to prove: (1) the callback
// handler alone can never redact output - so the misleading sentinel is
// correctly gone - and (2) the documented, actually-enforcing gate
// (wrapToolWithAssembly) still blocks a denied tool before it runs.
describe("LangChain post-execution redaction (AAASM-4799)", () => {
  it("does not redact real DynamicTool output on deny when only the callback handler is used", async () => {
    const gateway = createDenyingGatewayMock();
    const toolFunc = vi.fn(async (input: string) => `secret-result:${input}`);

    const dynamicTool = new DynamicTool({
      name: "danger_tool",
      description: "Danger operation",
      func: toolFunc
    });

    const handler = new AssemblyCallbackHandler(gateway);

    const output = await dynamicTool.invoke("payload", {
      callbacks: [handler],
      runId: "run-callback-only"
    });

    // The tool ran to completion - a callback alone cannot preempt execution -
    // and its real, unredacted output reaches the caller no matter the
    // gateway's decision. This is the documented limitation, not a bug to fix
    // in the callback layer.
    expect(toolFunc).toHaveBeenCalledTimes(1);
    expect(output).toBe("secret-result:payload");
    expect(handler.getPendingDenialCount()).toBe(0);
    expect(gateway.record).toHaveBeenCalledWith({
      action: "policy_post_block",
      runId: "run-callback-only",
      reason: "blocked-by-policy"
    });
  });

  it("still blocks the real DynamicTool pre-execution via wrapToolWithAssembly", async () => {
    const gateway = createDenyingGatewayMock();
    const toolFunc = vi.fn(async (input: string) => `secret-result:${input}`);

    const dynamicTool = new DynamicTool({
      name: "danger_tool",
      description: "Danger operation",
      func: toolFunc
    });

    const wrappedTool = wrapToolWithAssembly(dynamicTool, gateway, {
      generateRunId: () => "run-wrapped-deny"
    });

    await expect(
      wrappedTool.invoke("payload", {
        callbacks: [new AssemblyCallbackHandler(gateway)],
        runId: "run-wrapped-deny"
      })
    ).rejects.toBeInstanceOf(PolicyViolationError);

    // The wrapper layer throws before the tool's own invoke runs, so the
    // real function - and any output that would need redacting - never
    // executes at all.
    expect(toolFunc).not.toHaveBeenCalled();
  });
});
