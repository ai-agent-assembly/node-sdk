/**
 * AAASM-4735 — `initAssembly` must fail **loud** when it would wrap framework
 * tools whose `check()` routes through the allow-all no-op gateway client.
 *
 * When explicit `langchain.tools` are wrapped, each `invoke()` is gated by the
 * gateway client's `check()`. In a non-check-capable mode that client is the
 * no-op (`createNoopGatewayClient`, allow-all), so a policy DENY would be
 * silently allowed. Because an OMITTED `enforcementMode` resolves to enforce
 * (py/go parity, `resolveFailClosed`, AAASM-4172), that combination is a silent
 * fail-open and must throw `ConfigurationError` instead.
 *
 * The negative controls pin the guard's scope so it does not regress the
 * documented zero-config / registration-only paths (AAASM-1847 / 3050 / 3105):
 * registration-only inits (no wrapped tools) keep the no-op client, explicit
 * `observe` / `disabled` opt out, and the check-capable `napi-inprocess` mode is
 * unaffected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { initAssembly } from "../src/core/init-assembly.js";
import { ConfigurationError } from "../src/errors/index.js";

const BASE = { gatewayUrl: "https://gateway.example.com", apiKey: "k", agentId: "agent-1" } as const;
const TOOLS = { search_web: { name: "search_web", invoke: async () => "results" } };

describe("AAASM-4735: fail closed when wrapped tools route through the no-op client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("THROWS for langchain.tools + omitted enforcementMode in the default (auto) mode", async () => {
    await expect(initAssembly({ ...BASE, langchain: { tools: TOOLS } })).rejects.toThrow(
      ConfigurationError
    );
  });

  it("THROWS for langchain.tools + omitted enforcementMode in grpc-sidecar mode", async () => {
    await expect(
      initAssembly({ ...BASE, mode: "grpc-sidecar", langchain: { tools: TOOLS } })
    ).rejects.toThrow(ConfigurationError);
  });

  it("THROWS for langchain.tools + explicit enforce in a non-check-capable mode", async () => {
    await expect(
      initAssembly({ ...BASE, langchain: { tools: TOOLS }, enforcementMode: "enforce" })
    ).rejects.toThrow(ConfigurationError);
  });

  it("does NOT throw for registration-only init (no wrapped tools) in the default mode", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ctx = await initAssembly({ ...BASE });
    expect(ctx).toBeDefined();
    await ctx.shutdown();
  });

  it("does NOT throw for sdk-only registration-only init (no wrapped tools)", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ctx = await initAssembly({ ...BASE, mode: "sdk-only" });
    expect(ctx).toBeDefined();
    await ctx.shutdown();
  });

  it("does NOT throw for wrapped tools under explicit observe (advisory opt-out)", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ctx = await initAssembly({ ...BASE, langchain: { tools: TOOLS }, enforcementMode: "observe" });
    expect(ctx).toBeDefined();
    await ctx.shutdown();
  });

  it("does NOT throw for wrapped tools under explicit disabled", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ctx = await initAssembly({ ...BASE, langchain: { tools: TOOLS }, enforcementMode: "disabled" });
    expect(ctx).toBeDefined();
    await ctx.shutdown();
  });

  it("does NOT throw for wrapped tools in the check-capable napi-inprocess mode", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ctx = await initAssembly({ ...BASE, mode: "napi-inprocess", langchain: { tools: TOOLS } });
    expect(ctx).toBeDefined();
    await ctx.shutdown();
  });
});
