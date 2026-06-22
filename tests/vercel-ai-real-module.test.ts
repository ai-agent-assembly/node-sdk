// AAASM-3532 regression: drive the Vercel adapter against the *real* `ai` package
// (installed as a devDependency), not a `loadModule` fake. The real `ai` namespace
// is a frozen ES module exotic object, so the old `module.tool = …` patch threw
// `Cannot assign to read only property 'tool'`. This suite proves the shim-copy
// fix patches without crashing AND that governance flows through the governed
// factory the patch produces.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as realAi from "ai";
import type { GatewayClient } from "../src/gateway/client.js";

function createGatewayClientMock(): GatewayClient {
  return {
    mode: "sdk-only",
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    check: vi.fn(async () => ({ denied: false, pending: false })),
    waitForApproval: vi.fn(async () => ({ denied: false })),
    record: vi.fn(async () => undefined),
    recordResult: vi.fn(async () => undefined),
    scanPrompts: vi.fn(async () => undefined)
  };
}

afterEach(async () => {
  const hooks = await import("../src/hooks/ai-sdk.js");
  hooks.unpatchVercelAiSdk();
  hooks.vercelAiSdkPatchState.originalToolFactory = undefined;
  hooks.vercelAiSdkPatchState.patchedModule = undefined;
  hooks.vercelAiSdkPatchState.isPatched = false;
  hooks.vercelAiSdkPatchState.mutatedOriginal = false;
  vi.resetModules();
});

describe("vercel ai sdk adapter — real `ai` module", () => {
  it("confirms the real `ai` namespace is a frozen exotic object", () => {
    // Guards the premise of this suite: if `ai` ever ships a writable namespace,
    // the shim path stops being exercised and this test should be revisited.
    expect(typeof realAi.tool).toBe("function");
    expect(Object.isExtensible(realAi)).toBe(false);
    expect(() => {
      (realAi as unknown as { tool: unknown }).tool = undefined;
    }).toThrow(/read only property 'tool'/);
  });

  it("patches the real frozen `ai` module without crashing", async () => {
    const gateway = createGatewayClientMock();
    const hooks = await import("../src/hooks/ai-sdk.js");

    // Default loader (no `loadModule` fake) → imports the real, frozen `ai`.
    // With the pre-fix `module.tool = …` code this rejects with
    // `Cannot assign to read only property 'tool'`.
    const patched = await hooks.patchVercelAiSdk({ gatewayClient: gateway });

    expect(patched).toBe(true);
    expect(hooks.vercelAiSdkPatchState.isPatched).toBe(true);
    // The frozen namespace forced a shim copy, so we never mutated the original.
    expect(hooks.vercelAiSdkPatchState.mutatedOriginal).toBe(false);
    // The real `ai.tool` export is untouched (governance lives on the shim copy).
    expect(realAi.tool).toBe(hooks.vercelAiSdkPatchState.originalToolFactory);
  });

  it("applies governance through the governed factory from the real module", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "blocked-by-policy" }));
    const hooks = await import("../src/hooks/ai-sdk.js");

    await hooks.patchVercelAiSdk({ gatewayClient: gateway });

    const governedTool = hooks.vercelAiSdkPatchState.patchedModule?.tool;
    expect(typeof governedTool).toBe("function");

    const executed = vi.fn(async () => ({ ok: true }));
    // Build a tool through the real `ai` factory shape, then wrap via the patch.
    const governed = governedTool!({
      description: "delete database",
      // `inputSchema` is the real `ai` 5.x/6.x field; `parameters` kept for older.
      parameters: {},
      execute: executed
    } as never) as { execute?: (a: unknown, o: unknown) => Promise<unknown> };

    const error = await governed
      .execute!({ table: "users" }, { toolCallId: "real-call-1" })
      .catch((e: Error) => e);

    // Assert by `name`, not `instanceof`: `vi.resetModules()` between tests makes
    // the adapter construct PolicyViolationError from a fresh module graph whose
    // class identity differs from a statically-imported one.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("PolicyViolationError");
    expect((error as Error).message).toBe(
      "Tool blocked by governance policy: blocked-by-policy"
    );
    expect(executed).not.toHaveBeenCalled();
    expect(gateway.check).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "delete database", action: "tool_call" })
    );
  });

  it("allows governed execution through the real module on ALLOW", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));
    const hooks = await import("../src/hooks/ai-sdk.js");

    await hooks.patchVercelAiSdk({ gatewayClient: gateway });

    const governedTool = hooks.vercelAiSdkPatchState.patchedModule!.tool;
    const executed = vi.fn(async () => ({ ok: "allowed" }));
    const governed = governedTool({
      description: "read weather",
      parameters: {},
      execute: executed
    } as never) as { execute?: (a: unknown, o: unknown) => Promise<unknown> };

    const result = await governed.execute!({ city: "Tokyo" }, { toolCallId: "real-call-2" });

    expect(result).toEqual({ ok: "allowed" });
    expect(executed).toHaveBeenCalledTimes(1);
  });
});
