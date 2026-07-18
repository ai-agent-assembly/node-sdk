import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeClient } from "../src/native/client.js";

/**
 * AAASM-4847: in napi-inprocess mode the gateway client's audit/telemetry sinks
 * (record / recordResult / scanPrompts) are intentional no-ops — the native
 * runtime records its own decisions in-process and there is no separate gateway
 * wire to POST to. These tests pin that the sinks stay silent by default and
 * emit the one-time discoverability note only under AA_DEBUG=1.
 */
function fakeNativeClient(): NativeClient {
  return {
    mode: "napi-inprocess",
    canRegister: true,
    close: vi.fn(async () => undefined),
    sendEvent: vi.fn(() => undefined),
    queryPolicy: vi.fn(async () => ({ denied: false, pending: false })),
    register: vi.fn(async () => "")
  };
}

describe("napi-inprocess gateway client audit no-op (AAASM-4847)", () => {
  const originalDebug = process.env.AA_DEBUG;

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.AA_DEBUG;
    } else {
      process.env.AA_DEBUG = originalDebug;
    }
    vi.restoreAllMocks();
  });

  it("record/recordResult/scanPrompts are silent no-ops without AA_DEBUG", async () => {
    vi.resetModules();
    delete process.env.AA_DEBUG;
    const { createNativeGatewayClient } = await import("../src/gateway/client.js");
    const client = createNativeGatewayClient("napi-inprocess", fakeNativeClient(), "agent-noop");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await client.record({} as never);
    await client.recordResult({} as never);
    await client.scanPrompts({} as never);

    expect(stderr).not.toHaveBeenCalled();
  });

  it("emits the debug note at most once under AA_DEBUG=1 despite repeated calls", async () => {
    vi.resetModules();
    process.env.AA_DEBUG = "1";
    const { createNativeGatewayClient } = await import("../src/gateway/client.js");
    const client = createNativeGatewayClient("napi-inprocess", fakeNativeClient(), "agent-noop");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await client.record({} as never);
    await client.recordResult({} as never);
    await client.scanPrompts({} as never);

    const notes = stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("AAASM-4847"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("napi-inprocess");
  });
});
