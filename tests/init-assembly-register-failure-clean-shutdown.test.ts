import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AAASM-4652 — a tolerated (caught) agent-registration failure must not surface
 * later as a `shutdown()` rejection.
 *
 * `register` is advisory: a failed register is caught, logged, and init resolves
 * with `registered === false`. The post-register topology audit event still
 * ships unconditionally (lineage is independent of registration success). When
 * the failed register left the native IPC channel closed, that `sendEvent`
 * throws internally, the native client stashes the fault as `pendingSendError`,
 * and `close()` re-throws it — so the README default-mode quickstart's final
 * `await ctx.shutdown()` would REJECT with
 * `NativeSendEventError: ... IPC channel is closed (AA_ERR_SEND_EVENT)`.
 *
 * The fix keeps the advisory topology event firing but makes `initAssembly`'s
 * shutdown path swallow-and-log that stashed send error, so an advisory event
 * can never reject a clean shutdown. `close()`'s re-throw contract is unchanged
 * for direct callers.
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

describe("initAssembly clean shutdown after a tolerated register failure (AAASM-4652)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("register rejects and the channel is closed: reports registered=false and shutdown resolves without throwing", async () => {
    // Silence the expected "registration failed" warning so the test output
    // stays clean while still asserting on the observable contract.
    vi.spyOn(console, "warn").mockReturnValue(undefined);

    // `register` rejects (advisory failure) and a subsequent `sendEvent` throws
    // as if the IPC channel is closed — the exact shape that used to plant a
    // `pendingSendError` and reject `close()`.
    const binding = makeBinding({
      register: vi.fn(async () => {
        throw new Error("register failed");
      }),
      sendEvent: vi.fn(() => {
        // Native send failures are emitted in the shim's `AA_ERR_SEND_EVENT: …`
        // form so `mapNativeError` types them as `NativeSendEventError` — the
        // exact class the shutdown path discriminates on to swallow only the
        // advisory event fault (AAASM-4699).
        throw new Error("AA_ERR_SEND_EVENT: failed to enqueue event: IPC channel is closed");
      })
    });
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      agentId: "agent-x"
    });

    // The advisory register failure is tolerated: init resolves unregistered.
    expect(ctx.registered).toBe(false);
    expect(binding.register).toHaveBeenCalledOnce();

    // The core regression: shutdown must resolve cleanly, not reject with a
    // stashed NativeSendEventError from the advisory topology event.
    await expect(ctx.shutdown()).resolves.toBeUndefined();
  });
});
