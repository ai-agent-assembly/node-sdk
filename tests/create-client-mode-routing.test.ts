import { describe, expect, it, vi } from "vitest";

/**
 * AAASM-3050 — `createClient` routing decision.
 *
 * In `napi-inprocess` mode `createClient` must return a runtime-backed gateway
 * client whose `check()` consults the native `queryPolicy`. In every other mode
 * it returns the no-op client whose `check()` is allow-by-default (preserving
 * the pre-feature fail-open behavior). The native binding is mocked so the
 * routing decision can be verified without a compiled addon.
 */
async function loadCreateClientWithBinding(binding: {
  connect: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  queryPolicy: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();
  vi.doMock("node:module", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:module")>();
    return {
      ...actual,
      createRequire: () => () => binding
    };
  });
  return import("../src/core/init-assembly.js");
}

function makeBinding(decision: string, reason = "") {
  return {
    connect: vi.fn(async () => ({ id: "handle" })),
    sendEvent: vi.fn(() => undefined),
    queryPolicy: vi.fn(() => ({ decision, reason })),
    disconnect: vi.fn(async () => undefined)
  };
}

describe("createClient mode routing (AAASM-3050)", () => {
  it("napi-inprocess: check() consults the native runtime and maps DENY", async () => {
    const binding = makeBinding("deny", "blocked by policy");
    const mod = await loadCreateClientWithBinding(binding);

    const client = mod.createClient({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "k",
      agentId: "agent-1",
      mode: "napi-inprocess"
    });

    const decision = await client.check({
      action: "tool_call",
      toolName: "rm",
      args: [{ path: "/" }],
      runId: "run-1"
    });

    expect(decision).toEqual({ denied: true, pending: false, reason: "blocked by policy" });
    expect(binding.queryPolicy).toHaveBeenCalledWith(
      { id: "handle" },
      { agent_id: "agent-1", action_type: "tool_call", tool_name: "rm", args: [{ path: "/" }] }
    );
    await client.close();
  });

  it("napi-inprocess: a runtime ALLOW maps to a neutral decision", async () => {
    const binding = makeBinding("allow");
    const mod = await loadCreateClientWithBinding(binding);

    const client = mod.createClient({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "k",
      mode: "napi-inprocess"
    });

    await expect(
      client.check({ action: "tool_call", toolName: "search", runId: "run-2" })
    ).resolves.toEqual({ denied: false, pending: false });
    await client.close();
  });

  it("sdk-only: check() is allow-by-default and never loads the native binding", async () => {
    const binding = makeBinding("deny", "must-not-be-consulted");
    const mod = await loadCreateClientWithBinding(binding);

    const client = mod.createClient({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "k",
      mode: "sdk-only"
    });

    await expect(
      client.check({ action: "tool_call", toolName: "rm", runId: "run-3" })
    ).resolves.toEqual({ denied: false, pending: false });
    expect(binding.connect).not.toHaveBeenCalled();
    expect(binding.queryPolicy).not.toHaveBeenCalled();
  });
});
