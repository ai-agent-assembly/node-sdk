/**
 * Fail-open CONFORMANCE matrix across every enforcement integration (AAASM-4801).
 *
 * Systemic fix for the recurring per-round node fail-open finding
 * (AAASM-4735 → 4797/4798/4799): instead of one more single-integration
 * regression test, this pins the fail-open/closed invariant for ALL enforcement
 * integrations at once as a table-driven matrix — DRIVERS × SCENARIOS × MODES —
 * plus a completeness test that fails the moment a new integration is added
 * without a driver, and named regression guards for the three fixed bugs.
 *
 * Invariant (see `expectRan` in `drivers.ts` for the precise truth table):
 *   - enforce / omitted (fail-closed): a non-authoritative outcome (S1–S5) and
 *     any real deny (S6/S7) MUST NOT run the tool; a real allow (S8) runs.
 *   - observe / disabled (fail-open by design): a non-authoritative outcome
 *     (S1–S5) runs the tool; a real deny (S6/S7) still blocks (a deny is
 *     authoritative, not a fault); a real allow (S8) runs.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PolicyViolationError } from "../../src/errors/policy-violation-error.js";
import { ConfigurationError } from "../../src/errors/index.js";
import { createNativeGatewayClient, resolveVerdict } from "../../src/gateway/client.js";
import type { GatewayClient } from "../../src/gateway/client.js";
import type { NativeClient } from "../../src/native/client.js";
import { wrapToolWithAssembly } from "../../src/adapters/langchain/wrap-tool-with-assembly.js";
import type { LangChainToolLike } from "../../src/types/langchain-adapter.js";
import { AssemblyCallbackHandler } from "../../src/adapters/langchain/assembly-callback-handler.js";
import { openAIAgentsPatchState, patchOpenAIAgents } from "../../src/hooks/openai-agents.js";
import {
  DRIVERS,
  MODES,
  NON_ENFORCING_MODULES,
  SCENARIOS,
  expectRan,
  resetOpenAIState,
  runVercelFrozenEsm,
  type Driver,
  type Mode,
  type Scenario
} from "./drivers.js";

const SRC_ROOT = path.resolve(process.cwd(), "src");

/**
 * A source file is a candidate enforcement surface unless it is infrastructure
 * that only *routes* to integrations rather than gating a tool call itself:
 * barrels (`index.ts`), detection helpers (`*-detection.ts`), and the adapter
 * base interface + registry (`adapter.ts` / `adapter-registry.ts`). Applied by
 * file name regardless of directory depth so the rule holds under recursion.
 */
function isEnforcementSurfaceFile(file: string): boolean {
  return (
    file.endsWith(".ts") &&
    file !== "index.ts" &&
    file !== "adapter.ts" &&
    file !== "adapter-registry.ts" &&
    !file.endsWith("-detection.ts")
  );
}

/**
 * Enumerate the integration source modules on disk. A module counts as an
 * integration surface if it is a framework hook, a framework adapter, a tool
 * wrapper, or the shared gateway client (see {@link isEnforcementSurfaceFile}
 * for the exclusions).
 *
 * The scan **recurses** through `hooks/` and `adapters/` (AAASM-4810): the
 * earlier flat scan only looked at the fixed dirs `hooks/`, `adapters/langchain/`
 * and `wrappers/`, so a new integration nested one directory deeper — e.g.
 * `adapters/<framework>/wrap.ts` or `hooks/<framework>/…` — escaped the
 * completeness / anti-whack-a-mole guard entirely. Recursing means any new
 * enforcement module is discovered and must be classified (a driver, or a
 * documented non-enforcing module) no matter how deeply it is nested.
 *
 * `root` is parameterized so the recursion itself can be exercised against a
 * fixture tree; it defaults to the real `src/`.
 */
function enumerateIntegrationModules(root: string = SRC_ROOT): string[] {
  const modules: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (isEnforcementSurfaceFile(entry.name)) {
        modules.push(rel);
      }
    }
  };
  walk("hooks");
  walk("adapters");
  walk("wrappers");
  modules.push("gateway/client.ts");
  return modules.sort();
}

const supportedScenarios = (driver: Driver): Scenario[] =>
  SCENARIOS.filter((scenario) => driver.supports(scenario.id));

describe("fail-open conformance matrix (AAASM-4801)", () => {
  describe.each(DRIVERS.map((driver) => [driver.name, driver] as const))(
    "integration: %s",
    (_name, driver) => {
      describe.each(supportedScenarios(driver).map((s) => [`${s.id} ${s.label}`, s] as const))(
        "scenario: %s",
        (_scenarioName, scenario) => {
          it.each(MODES.map((mode) => [mode.id, mode] as const))(
            "mode %s: tool runs iff invariant allows",
            async (_modeId, mode) => {
              const outcome = await driver.run(scenario, mode);
              const shouldRun = expectRan(scenario, mode);

              expect(outcome.ran).toBe(shouldRun);
              // A tool that did not run must have been actively stopped (threw or
              // returned a denial output); a tool that ran must not have been
              // reported blocked. This catches a wrapper that "blocks" by
              // silently swallowing the call, or that reports a block yet still
              // executes.
              expect(outcome.blocked).toBe(!shouldRun);
            }
          );
        }
      );
    }
  );
});

/**
 * Vercel AI SDK frozen-ESM path — a KNOWN, DOCUMENTED limitation, now SURFACED not
 * silent (AAASM-4822 / AAASM-4842).
 *
 * The `vercel-ai (patchVercelAiSdk)` driver in DRIVERS exercises a WRITABLE plain
 * object and governs correctly — but that is not the shape a real app hits. A real
 * `ai` package is an ES module whose namespace is frozen; `patchVercelAiSdk` cannot
 * write the governed `tool` factory back onto it, so it would land only in an
 * internal shim copy the app never reads (`import { tool } from "ai"` keeps the
 * ORIGINAL, ungoverned factory). The fuller fix — a governed `tool()` exported from
 * the SDK — is still out of scope; documented in
 * `docs/07-compatibility-versioning/compatibility.md` (AAASM-3532).
 *
 * AAASM-4842 closes the SILENT part of that gap: `patchVercelAiSdk` no longer
 * over-claims success — it emits a loud, un-silenceable stderr warning and is
 * excluded from `activeAdapters` (asserted in the unit / init suites). It does NOT
 * hard-fail the auto-detected init path, because a frozen namespace is the shape of
 * every real `ai` and throwing on mere presence would regress zero-config
 * (AAASM-1847) and the auto-detected warn-not-throw invariant (AAASM-4769). So on
 * this path the tool still runs UNGOVERNED regardless of posture — the fix is the
 * loud signal, not a block. These cases pin that honest behavior so the matrix does
 * not over-claim a Vercel block it cannot deliver on frozen ESM.
 */
describe("Vercel AI SDK frozen-ESM path — surfaced-not-silent, still ungoverned (AAASM-4842)", () => {
  const enforce = MODES.find((mode): mode is Mode => mode.id === "enforce")!;
  const observe = MODES.find((mode): mode is Mode => mode.id === "observe")!;
  const authoritativeDeny = SCENARIOS.find((scenario): scenario is Scenario => scenario.id === "S7")!;

  it.each([
    ["enforce (fail-closed)", enforce],
    ["observe (fail-open)", observe]
  ])(
    "runs the tool UNGOVERNED under %s + authoritative DENY (auto-detect warns, never blocks/throws)",
    async (_label, mode) => {
      const outcome = await runVercelFrozenEsm(authoritativeDeny, mode);
      // Honest reality: governance never reaches the frozen namespace and the
      // auto-detected path never hard-fails, so even an authoritative DENY under
      // enforce does NOT stop the tool. The conformance suite must never claim a
      // `blocked` it cannot deliver here — the loud warning is the signal.
      expect(outcome.ran).toBe(true);
      expect(outcome.blocked).toBe(false);
    }
  );
});

describe("driver-registry completeness — anti-whack-a-mole (AAASM-4801)", () => {
  it("every integration module on disk is either an enforcement driver or explicitly non-enforcing", () => {
    const onDisk = enumerateIntegrationModules();
    const driverFiles = new Set(DRIVERS.map((driver) => driver.file));
    const nonEnforcing = new Set(Object.keys(NON_ENFORCING_MODULES));

    const unclassified = onDisk.filter(
      (module) => !driverFiles.has(module) && !nonEnforcing.has(module)
    );

    // If this fails, a new integration was added without a conformance driver.
    // Add a driver in `drivers.ts` (so it joins the fail-open matrix) or, if it
    // genuinely cannot gate a tool call, list it in NON_ENFORCING_MODULES with a
    // reason. Do NOT delete this assertion.
    expect(unclassified).toEqual([]);
  });

  it("every registered driver points at a module that still exists on disk", () => {
    const onDisk = new Set(enumerateIntegrationModules());
    const stale = DRIVERS.map((driver) => driver.file).filter((file) => !onDisk.has(file));
    expect(stale).toEqual([]);
  });

  it("every non-enforcing module still exists on disk", () => {
    const onDisk = new Set(enumerateIntegrationModules());
    const stale = Object.keys(NON_ENFORCING_MODULES).filter((file) => !onDisk.has(file));
    expect(stale).toEqual([]);
  });

  it("recurses into a nested adapters/<framework>/ integration (AAASM-4810)", () => {
    // A fixture src/ tree the enumerator walks. The pre-4810 flat scan only
    // looked at `adapters/langchain/`, so an integration under a *different*
    // nested adapter dir escaped classification. Assert the recursion now
    // discovers it — and still excludes barrels / detection helpers at depth.
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "aaasm-4810-"));
    try {
      for (const dir of ["hooks", "wrappers", "gateway", "adapters/newframework"]) {
        mkdirSync(path.join(fixtureRoot, dir), { recursive: true });
      }
      writeFileSync(path.join(fixtureRoot, "adapters/newframework/wrap-tool.ts"), "export {};");
      writeFileSync(path.join(fixtureRoot, "adapters/newframework/index.ts"), "export {};");
      writeFileSync(
        path.join(fixtureRoot, "adapters/newframework/tool-detection.ts"),
        "export {};"
      );
      writeFileSync(path.join(fixtureRoot, "gateway/client.ts"), "export {};");

      const discovered = enumerateIntegrationModules(fixtureRoot);

      expect(discovered).toContain("adapters/newframework/wrap-tool.ts");
      expect(discovered).not.toContain("adapters/newframework/index.ts");
      expect(discovered).not.toContain("adapters/newframework/tool-detection.ts");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("covers the enforcement integrations named in the ticket", () => {
    const driverFiles = DRIVERS.map((driver) => driver.file);
    expect(driverFiles).toEqual(
      expect.arrayContaining([
        "adapters/langchain/wrap-tool-with-assembly.ts",
        "hooks/ai-sdk.ts",
        "hooks/openai-agents.ts",
        "wrappers/with-assembly.ts",
        "gateway/client.ts"
      ])
    );
  });
});

/**
 * Named regression guards for the three fixed bugs. The matrix above already
 * exercises each through its integration; these assert the specific mechanism
 * directly so a regression names the exact ticket it reopened.
 */
function fakeNative(queryPolicy: NativeClient["queryPolicy"]): NativeClient {
  return {
    mode: "napi-inprocess",
    canRegister: true,
    close: async () => undefined,
    sendEvent: () => undefined,
    queryPolicy,
    register: async () => ""
  };
}

describe("regression guards (must fail if these bugs return)", () => {
  describe("AAASM-4797 — OpenAI-Agents patch must not become a silent no-op", () => {
    it("attaches to Agent.prototype.getAllTools and blocks a DENY without executing", async () => {
      resetOpenAIState();
      const state = { ran: false };
      const fakeTool = {
        type: "function",
        name: "send_email",
        invoke: async () => {
          state.ran = true;
          return "SENT";
        }
      };
      const agentClass = { prototype: { getAllTools: async () => [fakeTool] } };
      const gateway = createNativeGatewayClient(
        "napi-inprocess",
        fakeNative(async () => ({ denied: true, pending: false, reason: "policy-blocked" })),
        "agent-4797"
      );

      const patched = await patchOpenAIAgents({
        gatewayClient: gateway,
        loadAgentClass: async () => agentClass as never
      });

      expect(patched).toBe(true);
      expect(openAIAgentsPatchState.hookPoint).toBe("getAllTools");

      const [governed] = await agentClass.prototype.getAllTools();
      const output = await (
        governed as { invoke: (ctx: unknown, input: string) => Promise<unknown> }
      ).invoke({}, JSON.stringify({ to: "x" }));

      expect(state.ran).toBe(false);
      expect(output).toContain("Blocked by governance policy");
      resetOpenAIState();
    });

    it("throws loudly under enforce when NO hook point exists (never silently no-ops)", async () => {
      resetOpenAIState();
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const gateway = createNativeGatewayClient(
        "napi-inprocess",
        fakeNative(async () => ({ denied: false, pending: false })),
        "agent-4797",
        undefined,
        "enforce"
      );

      await expect(
        patchOpenAIAgents({
          gatewayClient: gateway,
          failClosed: true,
          loadAgentClass: async () => ({ prototype: {} }) as never
        })
      ).rejects.toBeInstanceOf(ConfigurationError);

      stderr.mockRestore();
      resetOpenAIState();
    });
  });

  describe("AAASM-4798 — resolveVerdict must fail closed on a malformed-but-resolved verdict", () => {
    it.each([
      ["empty object", {}],
      ["denied explicitly undefined", { denied: undefined }],
      ["wrong-type denied", { denied: "nope" }]
    ])("denies under enforce: %s", (_label, malformed) => {
      expect(resolveVerdict(malformed, true).denied).toBe(true);
    });

    it("stays allow under observe/disabled (fail-open)", () => {
      expect(resolveVerdict({}, false).denied).toBe(false);
    });

    it("createNativeGatewayClient denies a resolved-but-malformed verdict under enforce", async () => {
      const gateway = createNativeGatewayClient(
        "napi-inprocess",
        fakeNative(async () => ({}) as Awaited<ReturnType<NativeClient["queryPolicy"]>>),
        "agent-4798",
        undefined,
        "enforce"
      );
      const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "r" });
      expect(decision.denied).toBe(true);
    });
  });

  describe("AAASM-4799 — enforcement is the wrapper, not the audit-only callback", () => {
    function denyingGateway(): GatewayClient {
      return {
        mode: "sdk-only",
        start: async () => undefined,
        close: async () => undefined,
        check: async () => ({ denied: true, reason: "blocked" }),
        waitForApproval: async () => ({ denied: true }),
        record: async () => undefined,
        recordResult: async () => undefined,
        scanPrompts: async () => undefined
      };
    }

    it("the callback handler is audit-only: handleToolStart does NOT block on a DENY", async () => {
      const handler = new AssemblyCallbackHandler(denyingGateway());
      // The callback cannot preempt execution — it must resolve without throwing
      // even though the decision is a deny. (If a future change makes it throw,
      // that is a behavior change to review, not enforcement.)
      await expect(
        handler.handleToolStart({ name: "delete_db" }, {}, "run-1")
      ).resolves.toBeUndefined();
    });

    it("wrapToolWithAssembly IS the enforcement point: it blocks the same DENY", async () => {
      const state = { ran: false };
      const tool: LangChainToolLike = {
        name: "delete_db",
        invoke: async () => {
          state.ran = true;
          return "did-run";
        }
      };
      const wrapped = wrapToolWithAssembly(tool, denyingGateway());
      await expect(wrapped.invoke({})).rejects.toBeInstanceOf(PolicyViolationError);
      expect(state.ran).toBe(false);
    });
  });
});
