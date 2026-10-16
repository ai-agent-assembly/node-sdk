import { afterEach, describe, expect, it, vi } from "vitest";
import type { LangChainToolLike } from "../src/types/langchain-adapter.js";

// AAASM-6352: end-to-end through the real native-client verdict mapping, the
// native gateway client and wrapToolWithAssembly, with only the napi binding
// faked. Asserts on whether the tool function ran and with which args — not on
// the mapped verdict shape.
async function wrapWithVerdict(decision: string, failClosed: boolean) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => ({
      connect: vi.fn(async () => ({ id: "h" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision, reason: "policy" })),
      disconnect: vi.fn(async () => undefined)
    })
  }));
  const { createNativeClient } = await import("../src/native/client.js");
  const { createNativeGatewayClient } = await import("../src/gateway/client.js");
  // Re-imported after resetModules so the class identity matches the wrapper's.
  const { PolicyViolationError } = await import("../src/errors/index.js");
  const { wrapToolWithAssembly } = await import("../src/adapters/langchain/index.js");

  const nativeClient = createNativeClient({
    gateway: "/tmp/aa.sock",
    apiKey: "k",
    mode: "napi-inprocess",
    failClosed
  });
  const gateway = createNativeGatewayClient(
    "napi-inprocess",
    nativeClient,
    "agent-1",
    undefined,
    failClosed ? "enforce" : "observe"
  );
  const invoke = vi.fn<(args: unknown) => Promise<string>>(async () => "tool-result");
  const tool: LangChainToolLike = { name: "send_email", invoke };
  wrapToolWithAssembly(tool, gateway, { generateRunId: () => "run-1" });
  return { tool, invoke, PolicyViolationError };
}

const SECRET_ARGS = { body: "password=hunter2" };

afterEach(() => {
  vi.doUnmock("node:module");
});

describe("wrapped tool under a gateway REDACT verdict (AAASM-6352)", () => {
  it("enforce: does NOT run the tool and denies with the redaction reason", async () => {
    const { tool, invoke, PolicyViolationError } = await wrapWithVerdict("redact", true);

    await expect(tool.invoke(SECRET_ARGS)).rejects.toBeInstanceOf(PolicyViolationError);
    await expect(tool.invoke(SECRET_ARGS)).rejects.toThrow(/cannot apply client-side/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("enforce control: an ALLOW verdict runs the tool with its original args", async () => {
    const { tool, invoke } = await wrapWithVerdict("allow", true);

    await expect(tool.invoke(SECRET_ARGS)).resolves.toBe("tool-result");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toEqual(SECRET_ARGS);
  });

  it("observe: REDACT keeps advisory semantics and runs the tool", async () => {
    const { tool, invoke } = await wrapWithVerdict("redact", false);

    await expect(tool.invoke(SECRET_ARGS)).resolves.toBe("tool-result");
    expect(invoke.mock.calls[0]?.[0]).toEqual(SECRET_ARGS);
  });
});
