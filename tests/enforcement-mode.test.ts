/**
 * AAASM-1561 — verifies the enforcementMode parameter on initAssembly:
 * accepted values flow through, default omits the field, invalid strings
 * are rejected at runtime.
 */
import { describe, expect, it, vi } from "vitest";
import { initAssembly, type EnforcementMode } from "../src/index.js";

describe("initAssembly enforcementMode parameter", () => {
  // `enforce` is exercised separately: in a non-check-capable mode it now fails
  // closed (AAASM-3105), so it cannot be asserted on the allow-all `auto` path.
  it.each(["observe", "disabled"] as const)(
    "accepts %s and echoes it on the returned context",
    async (mode) => {
      const ctx = await initAssembly({
        gatewayUrl: "https://gateway.example.com",
        apiKey: "test-key",
        agentId: `agent-${mode}`,
        enforcementMode: mode
      });
      expect(ctx.enforcementMode).toBe(mode);
      await ctx.shutdown();
    }
  );

  it("defaults to undefined when omitted so the registration body keeps its pre-feature shape", async () => {
    // The gateway then applies its server-side default of live `enforce` —
    // semantic behaviour is unchanged for any caller who doesn't opt in.
    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key"
    });
    expect(ctx.enforcementMode).toBeUndefined();
    await ctx.shutdown();
  });

  it("throws RangeError on an unknown enforcementMode string", async () => {
    // Catches typos like "obesrve" coming from plain-JS / JSON-config /
    // dynamic-input callers who bypass the TypeScript union type.
    await expect(
      initAssembly({
        gatewayUrl: "https://gateway.example.com",
        apiKey: "test-key",
        // Bypass the type check explicitly to simulate a JS caller.
        enforcementMode: "obesrve" as unknown as EnforcementMode
      })
    ).rejects.toThrow(/enforcementMode must be one of/);
  });

  it("does not echo enforcementMode when caller didn't set it", async () => {
    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      // unrelated fields populated; enforcementMode left out
      teamId: "team-alpha"
    });
    expect(ctx.enforcementMode).toBeUndefined();
    expect(ctx.teamId).toBe("team-alpha");
    await ctx.shutdown();
  });
});

describe("enforcementMode on the registration wire", () => {
  // Mirrors the helper pattern from tests/topology-registration.test.ts so
  // the assertion is on the snake_case body actually sent to the gateway.
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
      disconnect: vi.fn(async () => undefined)
    };
  }

  async function loadInitAssemblyWithBinding(binding: MockBinding) {
    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: () => () => binding
    }));
    return import("../src/index.js");
  }

  it("emits enforcement_mode on the registration body when set", async () => {
    const binding = makeMockBinding();
    const { initAssembly: init } = await loadInitAssemblyWithBinding(binding);

    const ctx = await init({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess",
      enforcementMode: "observe"
    });
    await ctx.shutdown();

    expect(binding.sendEvent).toHaveBeenCalledWith(expect.any(Object), {
      event_type: "register",
      enforcement_mode: "observe"
    });
  });

  it("omits enforcement_mode from the registration body by default", async () => {
    const binding = makeMockBinding();
    const { initAssembly: init } = await loadInitAssemblyWithBinding(binding);

    const ctx = await init({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    const registrationCall = binding.sendEvent.mock.calls.find(
      ([, event]) => (event as Record<string, string>).event_type === "register"
    );
    expect(registrationCall).toBeDefined();
    const [, event] = registrationCall!;
    expect(event).not.toHaveProperty("enforcement_mode");
  });
});
