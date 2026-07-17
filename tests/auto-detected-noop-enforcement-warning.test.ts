/**
 * AAASM-4769 — residual of AAASM-4735: the init-time guard that throws for
 * wrapped `langchain.tools` is deliberately scoped to EXPLICIT tools (see
 * `wrapsToolsThroughGatewayClient` in `src/core/init-assembly.ts`) so a bare
 * dependency install of an auto-detected framework (Vercel AI SDK, OpenAI
 * Agents) stays zero-config (AAASM-1847) rather than hard-failing at init.
 * That leaves those frameworks' patched tool calls routing through the
 * allow-all no-op gateway client under a fail-closed posture with NO signal at
 * all. This suite asserts the best-effort fix: a one-time stderr warning from
 * `applyFrameworkPatches` (via `warnAutoDetectedToolsRouteThroughNoop`), fired
 * only when the resolved posture is fail-closed, the mode is not
 * "napi-inprocess", and no caller-supplied `gatewayClient` was given — the
 * exact combination under which those patched tools cannot actually be
 * blocked by a policy DENY.
 *
 * `@langchain/core`, `ai`, and `@openai/agents` are real (dev)dependencies in
 * this repo (see package.json), so `detectFrameworks()` auto-detects and
 * patches "vercel-ai-sdk" / "openai-agents" for real in every case below —
 * no `loadModule` faking needed to exercise the warning's gating logic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { initAssembly } from "../src/core/init-assembly.js";

interface FakeAgentInstance {
  calls: number;
}

interface FakeAgentClass {
  prototype: {
    _runTool: (
      this: FakeAgentInstance,
      toolCall: { function: { name: string; arguments: string } },
      context: { runId?: string; agentId?: string }
    ) => Promise<Record<string, unknown>>;
  };
}

const BASE = {
  gatewayUrl: "https://gateway.example.com",
  apiKey: "k",
  agentId: "agent-1"
} as const;

const NOOP_WARNING_SUBSTRING = "were patched for in-process tool governance";

function stderrMessages(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

describe("AAASM-4769: warn when an auto-detected framework's tools route through the no-op client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock("@openai/agents");
    vi.unmock("node:module");
    vi.resetModules();
  });

  it("WARNS for auto-detected frameworks + omitted enforcementMode in the default (auto) mode", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const ctx = await initAssembly({ ...BASE });

    expect(ctx).toBeDefined();
    expect(stderrMessages(stderrSpy)).toContain(NOOP_WARNING_SUBSTRING);
    await ctx.shutdown();
  });

  it("fires the warning at most once even though multiple auto-detected frameworks are patched", async () => {
    // The real `@openai/agents` devDependency's `Agent.prototype._runTool` shape
    // doesn't line up with `captureOriginalRunTool`'s expectations (see
    // `tests/openai-agents-hook.test.ts`), so patching it for real never
    // succeeds here. Fake the module (same pattern as that suite) so BOTH
    // vercel-ai-sdk and openai-agents patch successfully in the same
    // `initAssembly` call, to prove the warning collapses multiple patched
    // frameworks into a single message rather than firing once per framework.
    const fakeAgentClass: FakeAgentClass = {
      prototype: {
        _runTool: vi.fn(async function (this: FakeAgentInstance) {
          this.calls += 1;
          return { ok: true };
        })
      }
    };
    vi.doMock("@openai/agents", () => ({ Agent: fakeAgentClass }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: (packageName: string) => {
          if (packageName === "@openai/agents" || packageName === "ai") {
            return packageName;
          }
          throw new Error("MODULE_NOT_FOUND");
        }
      })
    }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { initAssembly: initAssemblyWithMocks } = await import("../src/core/init-assembly.js");

    const ctx = await initAssemblyWithMocks({ ...BASE });

    const occurrences = stderrSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes(NOOP_WARNING_SUBSTRING)
    );
    expect(occurrences).toHaveLength(1);
    // Both auto-detected frameworks patched in this call should be named in
    // that single warning rather than needing one warning each.
    expect(String(occurrences[0]?.[0])).toContain("vercel-ai-sdk");
    expect(String(occurrences[0]?.[0])).toContain("openai-agents");
    await ctx.shutdown();
  });

  it("does NOT warn in the check-capable napi-inprocess mode", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    let ctx: Awaited<ReturnType<typeof initAssembly>> | undefined;
    try {
      ctx = await initAssembly({ ...BASE, mode: "napi-inprocess" });
    } catch {
      // The native binding may be absent in this environment (built in a
      // separate CI job) — irrelevant to this assertion, which only checks
      // that the no-op-enforcement warning never fires for this mode.
    }
    expect(stderrMessages(stderrSpy)).not.toContain(NOOP_WARNING_SUBSTRING);
    await ctx?.shutdown();
  });

  it("does NOT warn when a caller-supplied gatewayClient is provided", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const gatewayClient = {
      mode: "sdk-only" as const,
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      check: vi.fn(async () => ({ denied: false, pending: false })),
      waitForApproval: vi.fn(async () => ({ denied: false })),
      record: vi.fn(async () => undefined),
      recordResult: vi.fn(async () => undefined),
      scanPrompts: vi.fn(async () => undefined)
    };

    const ctx = await initAssembly({ ...BASE, mode: "sdk-only", gatewayClient });

    expect(stderrMessages(stderrSpy)).not.toContain(NOOP_WARNING_SUBSTRING);
    await ctx.shutdown();
  });

  it("does NOT warn under explicit enforcementMode observe (advisory opt-out)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const ctx = await initAssembly({ ...BASE, enforcementMode: "observe" });

    expect(stderrMessages(stderrSpy)).not.toContain(NOOP_WARNING_SUBSTRING);
    await ctx.shutdown();
  });

  it("does NOT warn under explicit enforcementMode disabled", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const ctx = await initAssembly({ ...BASE, enforcementMode: "disabled" });

    expect(stderrMessages(stderrSpy)).not.toContain(NOOP_WARNING_SUBSTRING);
    await ctx.shutdown();
  });
});
