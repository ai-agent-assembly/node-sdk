import { describe, expect, it, vi } from "vitest";

interface MockBinding {
  connect: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  queryPolicy: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeMockBinding(): MockBinding {
  return {
    connect: vi.fn(async () => ({ id: "reg-handle" })),
    sendEvent: vi.fn(() => undefined),
    queryPolicy: vi.fn(async () => ({ denied: false, pending: false })),
    disconnect: vi.fn(async () => undefined),
  };
}

async function loadInitAssemblyWithBinding(binding: MockBinding) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => binding,
  }));
  return import("../src/index.js");
}

describe("topology registration on initAssembly", () => {
  it("sends registration event with all topology fields in napi-inprocess mode", async () => {
    const binding = makeMockBinding();
    const { initAssembly } = await loadInitAssemblyWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess",
      parentAgentId: "parent-agent-001",
      teamId: "team-alpha",
      delegationReason: "sub-task delegation",
      spawnedByTool: "search_tool",
    });

    await ctx.shutdown();

    expect(binding.sendEvent).toHaveBeenCalledWith(
      expect.any(Object),
      {
        event_type: "register",
        parent_agent_id: "parent-agent-001",
        team_id: "team-alpha",
        delegation_reason: "sub-task delegation",
        spawned_by_tool: "search_tool",
      }
    );
  });

  it("sends bare register event when no topology fields are provided", async () => {
    const binding = makeMockBinding();
    const { initAssembly } = await loadInitAssemblyWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess",
    });

    await ctx.shutdown();

    const registrationCall = binding.sendEvent.mock.calls.find(
      ([, event]) => (event as Record<string, string>).event_type === "register"
    );

    expect(registrationCall).toBeDefined();
    const [, event] = registrationCall!;
    expect(event).toEqual({ event_type: "register" });
  });

  it("registers and sends the registration event in grpc-sidecar mode via the binding", async () => {
    const binding = makeMockBinding();
    const { initAssembly } = await loadInitAssemblyWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "grpc-sidecar",
      parentAgentId: "parent-sidecar-001",
    });

    await ctx.shutdown();

    // AAASM-4468: grpc-sidecar now routes through the native aa-sdk-client
    // binding — it opens a session (connect) and ships the lineage registration
    // event, rather than the old no-op stub that touched nothing.
    expect(binding.connect).toHaveBeenCalled();
    expect(binding.sendEvent).toHaveBeenCalledWith(
      expect.any(Object),
      {
        event_type: "register",
        parent_agent_id: "parent-sidecar-001",
      }
    );
  });

  it("does not send registration event in sdk-only mode", async () => {
    const binding = makeMockBinding();
    const { initAssembly } = await loadInitAssemblyWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only",
      parentAgentId: "parent-sdk-only",
    });

    await ctx.shutdown();

    expect(binding.connect).not.toHaveBeenCalled();
    expect(binding.sendEvent).not.toHaveBeenCalled();
  });
});
