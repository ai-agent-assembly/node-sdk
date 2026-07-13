import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AAASM-4468 — the default `grpc-sidecar` mode's native `register` used to be a
 * no-op stub that resolved to a success-shaped `""`, so `initAssembly` reported
 * a clean init for an agent that was never registered (and would never appear in
 * the dashboard / `GET /api/v1/agents`). The fix makes the default path perform
 * a **real** gateway registration over gRPC (`registerViaGrpc`), so:
 *   - on success `initAssembly` reports `registered === true`;
 *   - on failure it does NOT silently succeed — the existing try/catch warns
 *     ("proceeding unregistered") and reports `registered === false`.
 *
 * These tests mock `registerViaGrpc` (no real socket) to pin both outcomes, plus
 * the `napi-inprocess` real-register path against a mocked native binding.
 */

const grpcMock = vi.hoisted(() => ({ registerViaGrpc: vi.fn<(...args: unknown[]) => Promise<string>>() }));
vi.mock("../src/native/grpc-register.js", () => ({ registerViaGrpc: grpcMock.registerViaGrpc }));

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

describe("initAssembly registration outcome on the default grpc-sidecar path (AAASM-4468)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:module");
    vi.resetModules();
    grpcMock.registerViaGrpc.mockReset();
  });

  it("default (grpc-sidecar) mode: reports registered=true when gRPC registration succeeds", async () => {
    grpcMock.registerViaGrpc.mockResolvedValue("policy-abc");
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const { initAssembly } = await import("../src/index.js");

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      agentId: "agent-x"
    });

    expect(ctx.registered).toBe(true);
    expect(grpcMock.registerViaGrpc).toHaveBeenCalledOnce();
    // No false-negative warning on a genuine registration.
    expect(warn.mock.calls.map((c) => String(c[0])).join("")).not.toContain("proceeding unregistered");

    await ctx.shutdown();
  });

  it("default (grpc-sidecar) mode: reports registered=false and warns when gRPC registration fails", async () => {
    grpcMock.registerViaGrpc.mockRejectedValue(new Error("gateway unreachable"));
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const { initAssembly } = await import("../src/index.js");

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      agentId: "agent-x"
    });

    // Not a silent success: the unregistered state is detectable and warned.
    expect(ctx.registered).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).join("")).toContain("proceeding unregistered");

    await ctx.shutdown();
  });

  it("napi-inprocess with a real register path: reports registered=true", async () => {
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "agent-y",
      mode: "napi-inprocess"
    });

    expect(ctx.registered).toBe(true);
    expect(binding.register).toHaveBeenCalledOnce();

    await ctx.shutdown();
  });
});
