import { describe, expect, it, vi } from "vitest";
import { AssemblyCallbackHandler } from "../src/adapters/langchain/index.js";
import type { GatewayClient } from "../src/gateway/client.js";

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

describe("AssemblyCallbackHandler", () => {
  it("tracks denied tool runs and records (but does not redact) output on handleToolEnd", async () => {
    // AAASM-4799: @langchain/core discards a callback handler's handleToolEnd
    // return value, so the handler cannot substitute/redact tool output - see
    // tests/langchain-callback-post-exec-redaction.test.ts for the real
    // @langchain/core regression test. This handler only records the deny as
    // an audit signal; the raw output still reaches the caller.
    const gateway = createGatewayMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "policy deny" }));

    const handler = new AssemblyCallbackHandler(gateway);

    await handler.handleToolStart({ name: "send_email" }, { to: "alice@example.com" }, "run-1");

    expect(handler.getPendingDenialCount()).toBe(1);

    const output = await handler.handleToolEnd("raw output", "run-1");
    expect(output).toBe("raw output");
    expect(handler.getPendingDenialCount()).toBe(0);

    expect(gateway.record).toHaveBeenCalledWith({
      action: "policy_post_block",
      runId: "run-1",
      reason: "policy deny"
    });
  });

  it("records tool result when no denial is pending", async () => {
    const gateway = createGatewayMock();
    const handler = new AssemblyCallbackHandler(gateway);

    const output = await handler.handleToolEnd("safe output", "run-2");

    expect(output).toBe("safe output");
    expect(gateway.recordResult).toHaveBeenCalledWith({
      runId: "run-2",
      output: "safe output"
    });
  });

  it("records prompt scan and llm response events", async () => {
    const gateway = createGatewayMock();
    const handler = new AssemblyCallbackHandler(gateway);

    await handler.handleLLMStart({ name: "gpt-model" }, ["prompt-a", "prompt-b"], "run-llm");
    await handler.handleLLMEnd({ content: "model-output" }, "run-llm");

    expect(gateway.scanPrompts).toHaveBeenCalledWith({
      prompts: ["prompt-a", "prompt-b"],
      runId: "run-llm",
      modelName: "gpt-model"
    });
    expect(gateway.record).toHaveBeenCalledWith({
      action: "llm_response",
      runId: "run-llm",
      output: { content: "model-output" }
    });
  });
});
