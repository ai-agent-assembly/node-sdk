import { describe, expect, it, vi } from "vitest";

/**
 * AAASM-3415 — lineage forwarding.
 *
 * `initAssembly` builds {@link RegisterOptions} from the SDK config via the
 * private `buildRegisterOptions` helper and hands them to the native
 * `register(handle, options)` primitive. These tests exercise that mapping
 * through the public `initAssembly` entrypoint (the helper is not exported),
 * capturing the exact options object forwarded to the native binding so the
 * lineage / team-scoping contract is pinned down value-by-value:
 *
 *  - `teamId`  -> team-budget attribution
 *  - `parentAgentId` -> topology lineage edge
 *
 * Both are optional and must be omitted (absent key, not `undefined`) when the
 * config does not carry them, so the native default resolution is preserved.
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

/** Capture the RegisterOptions forwarded to the native binding on boot. */
async function captureRegisterOptions(
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const binding = makeBinding();
  const { initAssembly } = await loadWithBinding(binding);
  const ctx = await initAssembly({
    gatewayUrl: "/tmp/aa.sock",
    apiKey: "test-key",
    mode: "napi-inprocess",
    ...config
  });
  await ctx.shutdown();
  expect(binding.register).toHaveBeenCalledOnce();
  return binding.register.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("buildRegisterOptions config -> RegisterOptions mapping (AAASM-3415)", () => {
  it("maps agentId / name / framework / gatewayEndpoint plus both lineage fields", async () => {
    const options = await captureRegisterOptions({
      agentId: "agent-7",
      name: "Lucky Seven",
      teamId: "team-payments",
      parentAgentId: "parent-42"
    });

    // Exact, complete shape — every SDK-config-derived field accounted for.
    expect(options).toEqual({
      agentId: "agent-7",
      name: "Lucky Seven",
      framework: "none",
      gatewayEndpoint: "/tmp/aa.sock",
      teamId: "team-payments",
      parentAgentId: "parent-42"
    });
  });

  it("forwards only teamId when parentAgentId is absent (parent omitted)", async () => {
    const options = await captureRegisterOptions({
      agentId: "agent-team-only",
      teamId: "team-research"
    });

    expect(options.teamId).toBe("team-research");
    expect(options).not.toHaveProperty("parentAgentId");
  });

  it("forwards only parentAgentId when teamId is absent (team omitted)", async () => {
    const options = await captureRegisterOptions({
      agentId: "agent-child-only",
      parentAgentId: "parent-99"
    });

    expect(options.parentAgentId).toBe("parent-99");
    expect(options).not.toHaveProperty("teamId");
  });

  it("emits neither lineage field and registers cleanly when neither is set", async () => {
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      agentId: "root-agent",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    const options = binding.register.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options).not.toHaveProperty("teamId");
    expect(options).not.toHaveProperty("parentAgentId");
    // Still a well-formed registration — no crash, base fields intact.
    expect(options).toMatchObject({
      agentId: "root-agent",
      name: "root-agent",
      framework: "none"
    });
  });
});

describe("lineage values round-trip to native register unmangled (AAASM-3415)", () => {
  it("preserves unicode team / parent identifiers byte-for-byte", async () => {
    const teamId = "équipe-paiements-日本語-🚀";
    const parentAgentId = "родитель-αβγ-✓";
    const options = await captureRegisterOptions({
      agentId: "agent-unicode",
      teamId,
      parentAgentId
    });

    expect(options.teamId).toBe(teamId);
    expect(options.parentAgentId).toBe(parentAgentId);
  });

  it("preserves a very long parentAgentId without truncation", async () => {
    const parentAgentId = `parent-${"a".repeat(4096)}`;
    const options = await captureRegisterOptions({
      agentId: "agent-long",
      teamId: "team-x",
      parentAgentId
    });

    expect(options.parentAgentId).toBe(parentAgentId);
    expect(String(options.parentAgentId)).toHaveLength(parentAgentId.length);
  });

  it("treats an empty-string teamId as unset (falsy -> omitted, no empty forward)", async () => {
    // buildRegisterOptions guards each lineage field with a truthiness check, so
    // an empty string never reaches the gateway as a spurious empty team scope.
    const options = await captureRegisterOptions({
      agentId: "agent-empty-team",
      teamId: "",
      parentAgentId: "parent-real"
    });

    expect(options).not.toHaveProperty("teamId");
    expect(options.parentAgentId).toBe("parent-real");
  });
});
