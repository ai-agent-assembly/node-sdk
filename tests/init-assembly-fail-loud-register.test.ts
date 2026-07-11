import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AAASM-4468 — the default `grpc-sidecar` mode's native `register` is a no-op
 * stub that resolves to a success-shaped `""`, so `initAssembly` used to report
 * a clean init for an agent that was never registered (and would never appear
 * in the dashboard / `GET /api/v1/agents`). The interim fix (N-C) makes that
 * no-op *visible* rather than silent: a prominent, unconditional stderr warning
 * at init time plus a `registered: boolean` flag on the returned context.
 *
 * These tests pin both surfaces:
 *  - the stub (default) path warns and reports `registered === false`;
 *  - a real register path (`napi-inprocess` against a mocked binding) does NOT
 *    warn and reports `registered === true`.
 *
 * The real in-SDK `grpc-sidecar` registration (direct `:50051` via the
 * `aa-sdk-client` binding, N-A) is gated on AAASM-4467 and out of scope here.
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

function collectStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

describe("initAssembly fail-loud on unregistered no-op path (AAASM-4468)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("default (grpc-sidecar) mode: reports registered=false and writes a prominent stderr warning", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { initAssembly } = await import("../src/index.js");

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      agentId: "agent-x"
    });

    // Programmatic surface: the unregistered state is detectable, not silent.
    expect(ctx.registered).toBe(false);

    // Warning surface: unconditional stderr, naming the concrete consequence
    // and the ticket the real registration is gated on.
    const warning = collectStderr(stderr);
    expect(warning).toContain("NOT registered");
    expect(warning).toContain("/api/v1/agents");
    expect(warning).toContain("AAASM-4467");

    await ctx.shutdown();
  });

  it("napi-inprocess with a real register path: reports registered=true and emits no unregistered warning", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "agent-y",
      mode: "napi-inprocess"
    });

    // The real transport actually registered the agent.
    expect(ctx.registered).toBe(true);
    expect(binding.register).toHaveBeenCalledOnce();

    // No false-negative: the fail-loud warning must NOT fire when registration
    // genuinely happened.
    expect(collectStderr(stderr)).not.toContain("NOT registered");

    await ctx.shutdown();
  });
});
