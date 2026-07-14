import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AAASM-4468 — default-mode (`grpc-sidecar` / `auto`) registration now routes
 * through the native `aa-sdk-client` binding, the same connect+register path as
 * `napi-inprocess` (ADR 0002 / 0004 — never a JS reimplementation of the
 * handshake). Two surfaces are pinned here:
 *
 *  - **binding present:** default mode registers the agent and reports
 *    `registered === true` with no unregistered warning.
 *  - **binding absent** (unsupported platform / missing native binary): the
 *    transport falls back to the no-op stub, so init must fail *loud* — a
 *    prominent, unconditional stderr warning plus `registered === false` — never
 *    a silent clean init for an agent that structurally never registered.
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

/** Load the SDK with the native binding load forced to fail (no binary). */
async function loadWithUnloadableBinding() {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => {
      throw new Error("Cannot find module (no native binary on this platform)");
    }
  }));
  return import("../src/index.js");
}

function collectStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

describe("initAssembly fail-loud when the native binding is unavailable (AAASM-4468)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("default (grpc-sidecar) mode with the binding present: registers and emits no unregistered warning", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const binding = makeBinding();
    const { initAssembly } = await loadWithBinding(binding);

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "test-key",
      agentId: "agent-x"
    });

    // The default path now performs the real SDK-side registration through the
    // aa-sdk-client binding.
    expect(ctx.registered).toBe(true);
    expect(binding.connect).toHaveBeenCalled();
    expect(binding.register).toHaveBeenCalledOnce();
    expect(collectStderr(stderr)).not.toContain("NOT registered");

    await ctx.shutdown();
  });

  it("default mode with no loadable binding: reports registered=false and writes a prominent stderr warning", async () => {
    // Pin a non-win32 platform so this exercises the generic "could not be
    // loaded" branch deterministically regardless of the host OS. On a real
    // Windows CI runner `process.platform` is `win32`, so `warnAgentUnregistered`
    // would emit the Windows-specific wording (asserted separately below) and
    // this generic assertion would fail — the Windows message intentionally omits
    // "could not be loaded".
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { initAssembly } = await loadWithUnloadableBinding();

      const ctx = await initAssembly({
        gatewayUrl: "https://gateway.example.com",
        apiKey: "test-key",
        agentId: "agent-x"
      });

      // Programmatic surface: the unregistered state is detectable, not silent.
      expect(ctx.registered).toBe(false);

      // Warning surface: unconditional stderr naming the concrete consequence and
      // why registration did not happen.
      const warning = collectStderr(stderr);
      expect(warning).toContain("NOT registered");
      expect(warning).toContain("/api/v1/agents");
      expect(warning).toContain("could not be loaded");

      await ctx.shutdown();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("on Windows with no loadable binding: the unregistered warning names Windows-not-supported", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { initAssembly } = await loadWithUnloadableBinding();

      const ctx = await initAssembly({
        gatewayUrl: "https://gateway.example.com",
        apiKey: "test-key",
        agentId: "agent-x"
      });

      expect(ctx.registered).toBe(false);

      const warning = collectStderr(stderr);
      // Windows-specific honesty: names Windows + "not supported", not the
      // generic "could not be loaded" (which reads as a fixable missing binary).
      expect(warning).toContain("Windows is not supported yet");
      expect(warning).toContain("NOT registered");
      expect(warning).toContain("/api/v1/agents");
      expect(warning).not.toContain("could not be loaded");

      await ctx.shutdown();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
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
