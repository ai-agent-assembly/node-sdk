import { describe, expect, it, vi } from "vitest";

/**
 * AAASM-3403 — wire the native `register` primitive (AAASM-3400) into the SDK.
 *
 * Two contracts are covered:
 *
 *  1. The `NativeClient` wrapper's `register()` delegates to the binding's
 *     `register(handle, options)` on the **same** session handle the
 *     `queryPolicy` path uses, so the gateway token attaches to subsequent
 *     queries.
 *  2. `initAssembly` calls `register()` on boot (napi-inprocess) with the
 *     RegisterOptions derived from the config, and a failed registration is
 *     swallowed so init proceeds unregistered (advisory SDK, fail-open).
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

async function loadWithBinding(binding: MockBinding) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => binding
  }));
  return import("../src/index.js");
}

async function loadNativeClientWithBinding(binding: MockBinding) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => binding
  }));
  return import("../src/native/client.js");
}

describe("native register wrapper (AAASM-3403)", () => {
  it("delegates to the binding on the same handle queryPolicy uses", async () => {
    const binding = makeBinding();
    const mod = await loadNativeClientWithBinding(binding);

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "k",
      mode: "napi-inprocess"
    });

    const policyId = await client.register({
      agentId: "agent-1",
      name: "Agent One",
      framework: "langchain-js"
    });
    await client.queryPolicy({ agent_id: "agent-1", action_type: "tool_call" });

    expect(policyId).toBe("policy-7");
    expect(binding.connect).toHaveBeenCalledTimes(1); // one shared session
    expect(binding.register).toHaveBeenCalledWith(
      { id: "handle" },
      { agentId: "agent-1", name: "Agent One", framework: "langchain-js" }
    );
    expect(binding.queryPolicy.mock.calls[0]?.[0]).toEqual({ id: "handle" });
    await client.close();
  });

  it("resolves neutrally when the binding has no register (pre-AAASM-3400)", async () => {
    const binding = makeBinding();
    // Simulate an older binding that predates the register primitive.
    const noRegister = { ...binding, register: undefined } as unknown as MockBinding;
    const mod = await loadNativeClientWithBinding(noRegister);

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "k",
      mode: "napi-inprocess"
    });

    await expect(
      client.register({ agentId: "a", name: "a", framework: "none" })
    ).resolves.toBe("");
    expect(binding.connect).not.toHaveBeenCalled();
    await client.close();
  });

  it("surfaces a binding register failure as a typed error", async () => {
    const binding = makeBinding({
      register: vi.fn(async () => {
        throw new Error("AA_ERR_REGISTER:gateway unreachable");
      })
    });
    const mod = await loadNativeClientWithBinding(binding);

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "k",
      mode: "napi-inprocess"
    });

    await expect(
      client.register({ agentId: "a", name: "a", framework: "none" })
    ).rejects.toBeInstanceOf(mod.NativeRegisterError);
    await client.close();
  });
});

describe("initAssembly registers the agent (AAASM-3403)", () => {
  it("calls native register with options from the config on napi-inprocess boot", async () => {
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "agent-9",
      name: "Ninth Agent",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    expect(binding.register).toHaveBeenCalledOnce();
    // AAASM-4468: `gatewayEndpoint` is intentionally omitted so aa-sdk-client
    // applies its default gRPC endpoint (127.0.0.1:50051); the HTTP gatewayUrl
    // must not be passed as the register endpoint.
    expect(binding.register).toHaveBeenCalledWith(
      { id: "handle" },
      {
        agentId: "agent-9",
        name: "Ninth Agent",
        framework: "none"
      }
    );
  });

  it("defaults name to agentId when name is omitted", async () => {
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "solo",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    expect(binding.register.mock.calls[0]?.[1]).toMatchObject({
      agentId: "solo",
      name: "solo"
    });
  });

  it("forwards teamId and parentAgentId to native register (AAASM-3415)", async () => {
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "child-1",
      teamId: "team-payments",
      parentAgentId: "parent-42",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    expect(binding.register.mock.calls[0]?.[1]).toMatchObject({
      agentId: "child-1",
      teamId: "team-payments",
      parentAgentId: "parent-42"
    });
  });

  it("omits teamId and parentAgentId when not configured (AAASM-3415)", async () => {
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "root-1",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    const options = binding.register.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("teamId");
    expect(options).not.toHaveProperty("parentAgentId");
  });

  it("proceeds unregistered when registration fails (fail-open)", async () => {
    const binding = makeBinding({
      register: vi.fn(async () => {
        throw new Error("AA_ERR_REGISTER:gateway down");
      })
    });
    const { initAssembly } = await loadWithBinding(binding);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // init must not reject just because the gateway rejected registration.
    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "agent-x",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("proceeding unregistered"));
    // Lineage audit event still ships.
    expect(binding.sendEvent).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not register in sdk-only mode (no session to register against)", async () => {
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      mode: "sdk-only"
    });
    await ctx.shutdown();

    expect(binding.connect).not.toHaveBeenCalled();
    expect(binding.register).not.toHaveBeenCalled();
  });
});
