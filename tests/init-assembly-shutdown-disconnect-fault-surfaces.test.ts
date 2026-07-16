import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AAASM-4699 — a genuine native disconnect fault must surface from
 * `shutdown()`, not be swallowed as an "advisory event error".
 *
 * The AAASM-4652 shutdown fix wrapped `nativeClient.close()` in a blanket
 * try/catch that logged EVERY failure as an advisory event error. That
 * over-swallowed: a real `NativeDisconnectError` (AA_ERR_DISCONNECT) raised
 * while tearing down the native session was mislabeled and hidden instead of
 * surfacing. The fix discriminates — only a `NativeSendEventError` (the
 * advisory topology-event send fault) is swallowed; anything else is re-thrown.
 *
 * This is the complement of the clean-shutdown test: register succeeds and no
 * send error is pending, so the ONLY failure is `disconnect` itself rejecting —
 * which must propagate as the mapped `NativeDisconnectError`.
 */

interface MockBinding {
  connect: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  queryPolicy: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeBinding(overrides: Partial<MockBinding> = {}): MockBinding {
  return {
    connect: vi.fn(async () => ({ id: "handle" })),
    sendEvent: vi.fn(() => undefined),
    queryPolicy: vi.fn(async () => ({ decision: "allow", reason: "" })),
    register: vi.fn(async () => "policy-7"),
    disconnect: vi.fn(async () => undefined),
    ...overrides
  };
}

/** Load the SDK with the native binding stubbed by the given mock. */
async function loadWithBinding(binding: MockBinding) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => binding
  }));
  return import("../src/index.js");
}

describe("initAssembly shutdown surfaces a real disconnect fault (AAASM-4699)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("register succeeds, no pending send error, but disconnect rejects: shutdown rejects with NativeDisconnectError", async () => {
    // `disconnect` raises the shim's typed disconnect fault; register succeeds
    // and `sendEvent` is a no-op, so no `pendingSendError` is stashed — the
    // disconnect fault is the sole failure and must not be swallowed.
    const binding = makeBinding({
      disconnect: vi.fn(async () => {
        throw new Error("AA_ERR_DISCONNECT: session teardown failed");
      })
    });
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      agentId: "agent-x"
    });

    // The disconnect fault surfaces from shutdown() as the mapped typed error,
    // rather than being logged and swallowed as an advisory event error.
    await expect(ctx.shutdown()).rejects.toMatchObject({ code: "AA_ERR_DISCONNECT" });
    expect(binding.disconnect).toHaveBeenCalledOnce();
  });
});
