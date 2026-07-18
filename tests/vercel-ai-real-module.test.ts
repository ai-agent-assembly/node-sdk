// AAASM-3532 / AAASM-4842 regression: drive the Vercel adapter against the *real*
// `ai` package (installed as a devDependency), not a `loadModule` fake. The real
// `ai` namespace is a frozen ES module exotic object, so `patchVercelAiSdk` can
// neither assign the governed factory back onto it (the AAASM-3532 read-only crash)
// nor deliver governance through it — the governed factory would land only in a
// shim copy the app never reads. AAASM-4842 makes that inert path fail LOUD instead
// of over-claiming success: it always WARNS and never reports a patch, and — only
// when a direct caller opts in via `throwOnFrozenInert` — throws. The auto-detected
// init path deliberately does NOT opt in, so a bare `ai` install stays zero-config
// (AAASM-1847 / 4769). This suite pins that honest behavior against the real module.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as realAi from "ai";
import { ConfigurationError } from "../src/errors/index.js";
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
    // the frozen path stops being exercised and this test should be revisited.
    expect(typeof realAi.tool).toBe("function");
    expect(Object.isExtensible(realAi)).toBe(false);
    expect(() => {
      (realAi as unknown as { tool: unknown }).tool = undefined;
    }).toThrow(/read only property 'tool'/);
  });

  it("does NOT crash on the frozen `ai`, but warns and returns false without reporting a patch", async () => {
    const gateway = createGatewayClientMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");

      // Default loader (no `loadModule` fake) → imports the real, frozen `ai`.
      // The pre-AAASM-3532 `module.tool = …` code rejected here; the shim fallback
      // means we no longer crash. AAASM-4842: the inert shim is NOT reported as a
      // patch — under observe/disabled we warn and return false.
      const patched = await hooks.patchVercelAiSdk({ gatewayClient: gateway });

      expect(patched).toBe(false);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      // The real `ai.tool` export is untouched (the frozen namespace was never mutated).
      expect(realAi.tool).toBe(hooks.vercelAiSdkPatchState.originalToolFactory);
      const warning = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(warning).toContain("[agent-assembly] WARNING");
      expect(warning).toContain("frozen");
      expect(warning).toContain("AAASM-4842");
    } finally {
      stderr.mockRestore();
    }
  });

  it("throws ConfigurationError on the frozen `ai` when a direct caller opts into throwOnFrozenInert", async () => {
    const gateway = createGatewayClientMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");

      const error = await hooks
        .patchVercelAiSdk({ gatewayClient: gateway, throwOnFrozenInert: true })
        .catch((e: Error) => e);

      // Assert by `name`, not `instanceof`: `vi.resetModules()` between tests makes
      // the adapter construct ConfigurationError from a fresh module graph whose
      // class identity differs from a statically-imported one.
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe(ConfigurationError.name);
      expect((error as Error).message).toMatch(/frozen ES module/);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      expect(realAi.tool).toBe(hooks.vercelAiSdkPatchState.originalToolFactory);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("does NOT throw on the frozen `ai` under failClosed alone — the auto-detected init posture stays zero-config", async () => {
    const gateway = createGatewayClientMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");

      // This is exactly what `patchDetectedVercelAiSdk` passes under enforce: only
      // `failClosed` (the AAASM-4805 moved-hook flag), never `throwOnFrozenInert`.
      // On the real frozen `ai` it must warn and decline, NOT hard-fail init —
      // otherwise every enforce user with `ai` installed loses zero-config
      // (AAASM-1847 / 4769).
      const patched = await hooks.patchVercelAiSdk({ gatewayClient: gateway, failClosed: true });

      expect(patched).toBe(false);
      expect(hooks.vercelAiSdkPatchState.isPatched).toBe(false);
      expect(realAi.tool).toBe(hooks.vercelAiSdkPatchState.originalToolFactory);
      const warning = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(warning).toContain("AAASM-4842");
    } finally {
      stderr.mockRestore();
    }
  });

  it("leaves the app's `import { tool } from 'ai'` factory UNGOVERNED (the known frozen-ESM limitation)", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "blocked-by-policy" }));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const hooks = await import("../src/hooks/ai-sdk.js");
      // observe/disabled posture: warns and declines to patch (returns false).
      await hooks.patchVercelAiSdk({ gatewayClient: gateway });

      // The app builds a tool through the REAL `ai.tool` factory — the same binding
      // it holds from `import { tool } from "ai"`. Governance never reached it, so
      // its execute runs unimpeded even though the gateway would DENY. This pins the
      // honest limitation (the fuller fix — a governed tool() exported from the SDK
      // — is out of scope for AAASM-4842; the loud warning is the shipped signal).
      const executed = vi.fn(async () => ({ ok: true }));
      const appTool = realAi.tool({
        description: "delete database",
        inputSchema: undefined,
        execute: executed
      } as never) as { execute?: (a: unknown, o: unknown) => Promise<unknown> };

      const result = await appTool.execute!({ table: "users" }, { toolCallId: "real-call-1" });

      expect(result).toEqual({ ok: true });
      expect(executed).toHaveBeenCalledTimes(1);
      expect(gateway.check).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
