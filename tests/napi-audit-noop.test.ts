import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeClient } from "../src/native/client.js";

/**
 * AAASM-5750, superseding AAASM-4847.
 *
 * This file used to pin the opposite behaviour: in napi-inprocess mode the
 * gateway client's audit sinks (record / recordResult / scanPrompts) were
 * deliberate no-ops that emitted a one-time `AA_DEBUG=1` note, on the reasoning
 * that "there is no separate gateway wire to POST to". That was true of the
 * gateway's HTTP surface and false of the runtime's native channel, which was
 * already open and already carrying the boot registration event. The sinks now
 * send on it.
 *
 * The file is kept rather than deleted because the superseded claim is the point:
 * the assertions below are the inversion of what shipped, so a revert to the
 * no-op reddens the exact tests that used to demand it, and the `AA_DEBUG` note
 * cannot quietly return.
 */
function fakeNativeClient(overrides: Partial<NativeClient> = {}): NativeClient {
  return {
    mode: "napi-inprocess",
    canRegister: true,
    close: vi.fn(async () => undefined),
    sendEvent: vi.fn(() => undefined),
    queryPolicy: vi.fn(async () => ({ denied: false, pending: false })),
    register: vi.fn(async () => ""),
    ...overrides
  };
}

describe("napi-inprocess gateway client audit sinks (AAASM-5750)", () => {
  const originalDebug = process.env.AA_DEBUG;

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.AA_DEBUG;
    } else {
      process.env.AA_DEBUG = originalDebug;
    }
    vi.restoreAllMocks();
  });

  it("sends all three audit methods to the native event channel", async () => {
    vi.resetModules();
    delete process.env.AA_DEBUG;
    const { createNativeGatewayClient } = await import("../src/gateway/client.js");
    const native = fakeNativeClient();
    const client = createNativeGatewayClient("napi-inprocess", native, "agent-audit");

    await client.record({ action: "tool_call_denied", runId: "r1", reason: "blocked" });
    await client.recordResult({ runId: "r1", output: "OUT" });
    await client.scanPrompts({ prompts: ["p"], runId: "r1" });

    // Each method must produce its own event, and they must be distinguishable:
    // one `sendEvent` call for three audit calls would mean two of them are lost,
    // and three identical events would mean the payload says nothing.
    const eventTypes = vi
      .mocked(native.sendEvent)
      .mock.calls.map((call) => (call[0] as { event_type?: string }).event_type);
    expect(eventTypes).toEqual(["tool_call_audit", "tool_result", "prompt_scan"]);
  });

  it("emits no AA_DEBUG note, because there is no longer a drop to disclose", async () => {
    vi.resetModules();
    process.env.AA_DEBUG = "1";
    const { createNativeGatewayClient } = await import("../src/gateway/client.js");
    const client = createNativeGatewayClient("napi-inprocess", fakeNativeClient(), "agent-audit");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await client.record({ action: "tool_call_denied", runId: "r1" });
    await client.recordResult({ runId: "r1", output: "OUT" });
    await client.scanPrompts({ prompts: ["p"], runId: "r1" });

    const notes = stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("AAASM-4847"));
    expect(notes).toEqual([]);
  });

  it("declares and behaves as discarded when the native binding did not load", async () => {
    // The fallback stub `createNativeClient` returns on an unsupported platform:
    // its `sendEvent` is a no-op, so "forwarded" would be a claim about a channel
    // that is not there. This is the input that makes the computed disposition
    // move — without it the value could be a constant.
    vi.resetModules();
    delete process.env.AA_DEBUG;
    const { createNativeGatewayClient } = await import("../src/gateway/client.js");
    const stub = fakeNativeClient({ canRegister: false });
    const client = createNativeGatewayClient("napi-inprocess", stub, "agent-audit");

    expect(client.auditSink).toBe("discarded");
    expect(createNativeGatewayClient("napi-inprocess", fakeNativeClient(), "a").auditSink).toBe(
      "forwarded"
    );
  });

  it("does not let a non-serializable tool result fail the audit call", async () => {
    // `recordResult` takes `unknown`, and the hook layer awaits it inside the
    // governed call. A circular structure must degrade to a lossy record, never
    // to a thrown audit sink.
    vi.resetModules();
    const { createNativeGatewayClient } = await import("../src/gateway/client.js");
    const native = fakeNativeClient();
    const client = createNativeGatewayClient("napi-inprocess", native, "agent-audit");

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(client.recordResult({ runId: "r1", output: circular })).resolves.toBeUndefined();
    expect(native.sendEvent).toHaveBeenCalledTimes(1);
  });
});
