/**
 * AAASM-5681 / AAASM-5750 — what a shipped gateway client does with hook-layer
 * audit events, and whether it says so.
 *
 * `record` / `recordResult` / `scanPrompts` all return `Promise<void>`, so a
 * client that sends the event and a client that drops it are indistinguishable
 * to the caller. Both shipped clients used to drop it; the native one now
 * forwards it to the runtime, and the no-op one still holds no transport to send
 * on.
 *
 * The suite pins three separate things, because any one of them alone can pass
 * while a defect is present:
 *
 *  1. Every shipped client *declares* an `auditSink` disposition.
 *  2. The declaration matches what the client actually does — one that says
 *     `"forwarded"` must reach the boundary with the event, one that says
 *     `"discarded"` must reach nothing, both measured against a boundary proven
 *     reachable by a positive control.
 *  3. `initAssembly` surfaces the drop on the DEFAULT path, with `AA_DEBUG`
 *     unset, both on stderr and programmatically as `context.auditSink` — and
 *     stays quiet on the path that has no drop.
 *
 * Assertions here are over the real shipped clients. The `NativeClient` stub is
 * not a stand-in for the code under test — it is the downstream boundary. No
 * test here injects a sink into the SDK's own path: a suite that supplies its
 * own recording client proves that client records and stays green over a client
 * wired to nothing, which is the defect AAASM-5749 found one row over.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gatewayModule from "../src/gateway/index.js";
import { createNativeGatewayClient, createNoopGatewayClient } from "../src/gateway/index.js";
import { createClient, initAssembly } from "../src/core/init-assembly.js";
import { withAssembly } from "../src/wrappers/with-assembly.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { NativeClient } from "../src/native/client.js";

const BASE = {
  gatewayUrl: "https://gateway.example.com",
  apiKey: "k",
  agentId: "agent-1"
} as const;

const DISCARD_WARNING_SUBSTRING = "hook-layer audit events are DISCARDED";

/**
 * Records every crossing of the native boundary.
 *
 * `canRegister: true` because that flag *is* "the native binding loaded", which
 * is the fact the record path and the computed disposition both key off. A
 * boundary that reported `false` would be standing in for the fallback stub — a
 * client with no channel — and every forwarding assertion below would then be
 * measuring the wrong client. The stub case is covered deliberately, in
 * `napi-audit-noop.test.ts`.
 */
function boundary(): { native: NativeClient; crossings: string[] } {
  const crossings: string[] = [];
  const native = {
    canRegister: true,
    queryPolicy: async (query: unknown) => {
      crossings.push(`queryPolicy:${JSON.stringify(query)}`);
      return { denied: false, pending: false };
    },
    sendEvent: (event: unknown) => {
      crossings.push(`sendEvent:${JSON.stringify(event)}`);
    },
    close: async () => {
      crossings.push("close");
    }
  } as unknown as NativeClient;
  return { native, crossings };
}

function stderrText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

/**
 * Every gateway-client factory the module actually exports, discovered rather
 * than listed.
 *
 * A hand-maintained literal is a list, not a gate: review of #363 added a third
 * exported, discarding, undeclared `createThirdGatewayClient` and the suite went
 * `9 passed (9)`. Reading the module's own exports is what makes a new shipped
 * client fail by default instead of passing by omission.
 */
/**
 * The methods that make an object a governance client. Membership is decided by
 * this shape, so a shipped client cannot escape the gate by being named
 * differently.
 */
const GATEWAY_CLIENT_SHAPE = ["check", "record", "recordResult", "scanPrompts"] as const;

function exportedClientFactoryNames(): string[] {
  return Object.keys(gatewayModule)
    .filter((name) => {
      const value = (gatewayModule as unknown as Record<string, unknown>)[name];
      if (typeof value !== "function") {
        return false;
      }
      // Detect by the SHAPE it returns, not by its name. A name pattern is
      // still a list: review demonstrated `createGatewayClientFromEnv` escaping
      // `/^create[A-Za-z]*GatewayClient$/` at `11 passed (11)`, and
      // `makeGatewayClient` / `newGatewayClient` / `createGatewayClientV2`
      // would too. A factory that returns a governance client is one whatever
      // it is called.
      let built: unknown;
      try {
        built = (value as (...args: unknown[]) => unknown)(
          "napi-inprocess",
          boundary().native,
          "agent-1"
        );
      } catch {
        return false; // not a zero-config factory; not a shipped client
      }
      if (typeof built !== "object" || built === null) {
        return false;
      }
      const candidate = built as Record<string, unknown>;
      return GATEWAY_CLIENT_SHAPE.every((method) => typeof candidate[method] === "function");
    })
    .sort();
}

/**
 * Construct an exported factory without knowing its signature. Both current
 * factories take `mode` first and ignore trailing arguments they do not
 * declare, so this shape builds either; the assertions below only read
 * `auditSink`.
 */
function buildByName(name: string): GatewayClient {
  const factory = (gatewayModule as unknown as Record<string, unknown>)[name] as (
    ...args: unknown[]
  ) => GatewayClient;
  return factory("napi-inprocess", boundary().native, "agent-1");
}

/**
 * The explicitly-constructed clients, for the behavioural assertions that need a
 * correctly-built instance. Exhaustiveness against the module is asserted
 * separately, so this list cannot silently fall behind.
 */
const SHIPPED_CLIENTS: ReadonlyArray<{ name: string; build: () => GatewayClient }> = [
  { name: "createNoopGatewayClient", build: () => createNoopGatewayClient("auto") },
  {
    name: "createNativeGatewayClient",
    build: () => createNativeGatewayClient("napi-inprocess", boundary().native, "agent-1")
  }
];

describe("AAASM-5681: shipped clients declare what they do with audit events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AA_DEBUG;
  });

  it("EVERY exported client factory declares a disposition — discovered, not listed", () => {
    // The gate. A newly exported factory is covered the moment it exists; it
    // does not have to be remembered into a literal.
    const names = exportedClientFactoryNames();
    expect(names.length).toBeGreaterThan(0); // the discovery itself must work
    for (const name of names) {
      expect(buildByName(name).auditSink, `${name} must declare an auditSink`).toBeDefined();
    }
  });

  it("the explicit list covers exactly what the module exports", () => {
    // Keeps the behavioural cases below honest: if a factory is added and not
    // given real construction here, this fails rather than the case silently
    // going unexercised.
    expect(SHIPPED_CLIENTS.map((c) => c.name).sort()).toEqual(exportedClientFactoryNames());
  });

  it.each(SHIPPED_CLIENTS)("$name declares an auditSink disposition", ({ build }) => {
    // An omitted disposition reads as "caller-supplied" — the absence of a
    // claim. A client this package ships must never be in that state: it would
    // let a dropping sink present as one the SDK cannot speak for.
    expect(build().auditSink).toBeDefined();
    expect(["forwarded", "discarded"]).toContain(build().auditSink);
  });

  it("the two shipped clients do NOT declare the same thing", () => {
    // The disposition is only worth reading if it discriminates. Asserting each
    // client against its own expected literal would pass over an implementation
    // that returned one constant for both, which is what the field looked like
    // before there was a channel to distinguish.
    expect(createNativeGatewayClient("napi-inprocess", boundary().native, "agent-1").auditSink).toBe(
      "forwarded"
    );
    expect(createNoopGatewayClient("auto").auditSink).toBe("discarded");
  });

  it("the native client's boundary IS reachable — positive control", async () => {
    const { native, crossings } = boundary();
    const client = createNativeGatewayClient("napi-inprocess", native, "agent-1");
    await client.check({ action: "tool_call", toolName: "bash", runId: "r1" });
    // Without this, the empty-crossings assertion below would pass even if the
    // probe could never observe anything.
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toContain("queryPolicy");
  });

  it("a client declaring \"forwarded\" reaches the boundary with every audit method", async () => {
    const { native, crossings } = boundary();
    const client = createNativeGatewayClient("napi-inprocess", native, "agent-1");
    expect(client.auditSink).toBe("forwarded");

    await client.record({ action: "tool_call_denied", runId: "r1", reason: "DENY-REASON-PROBE" });
    await client.recordResult({ runId: "r1", output: "RESULT-PROBE" });
    await client.scanPrompts({ prompts: ["PROMPT-PROBE"], runId: "r1" });

    // Three distinct crossings carrying three distinct payloads. A count alone
    // would pass over three copies of the same event; the payload assertions are
    // what make each method's own wiring falsifiable.
    const sends = crossings.filter((crossing) => crossing.startsWith("sendEvent:"));
    expect(sends).toHaveLength(3);
    expect(sends[0]).toContain("DENY-REASON-PROBE");
    expect(sends[1]).toContain("RESULT-PROBE");
    expect(sends[2]).toContain("PROMPT-PROBE");
  });

  it("a governed tool call through withAssembly forwards the deny to the boundary", async () => {
    // The interceptor, not the client in isolation. AC1's denied path: the SDK's
    // own wrapper is what builds the event, and nothing here supplies a sink.
    const { native, crossings } = boundary();
    const denyingNative = {
      ...(native as unknown as Record<string, unknown>),
      queryPolicy: async (query: unknown) => {
        crossings.push(`queryPolicy:${JSON.stringify(query)}`);
        return { denied: true, reason: "policy forbids DENY-PROBE" };
      }
    } as unknown as NativeClient;
    const client = createNativeGatewayClient("napi-inprocess", denyingNative, "agent-1");

    const tools = { bash: { execute: async () => "should never run" } };
    withAssembly(tools, { gatewayClient: client });
    await expect(tools.bash.execute()).rejects.toThrow(/DENY-PROBE/);

    // Positive control on the same boundary, kept separate from the finding: the
    // check crossed. Without it an empty send list is indistinguishable from a
    // probe that never ran.
    expect(crossings.some((crossing) => crossing.startsWith("queryPolicy:"))).toBe(true);
    const sends = crossings.filter((crossing) => crossing.startsWith("sendEvent:"));
    expect(sends.some((crossing) => crossing.includes("DENY-PROBE"))).toBe(true);
  });

  it("the no-op client's audit methods resolve to undefined and retain nothing", async () => {
    const client = createNoopGatewayClient("auto");
    expect(client.auditSink).toBe("discarded");
    await expect(client.record({ action: "tool_call", runId: "r1" })).resolves.toBeUndefined();
    await expect(client.recordResult({ runId: "r1", output: "x" })).resolves.toBeUndefined();
    await expect(
      client.scanPrompts({ prompts: ["p"], runId: "r1" })
    ).resolves.toBeUndefined();
  });

  it("createClient resolves a declared client on each path, and they differ", () => {
    // Guards the wiring: if `createClient` ever returned something undeclared,
    // `initAssembly` would silently stop warning — or start warning on the path
    // that has nothing to warn about.
    expect(createClient({ ...BASE, mode: "auto" }).auditSink).toBe("discarded");
    expect(
      createClient({ ...BASE, mode: "napi-inprocess", enforcementMode: "observe" }, boundary().native)
        .auditSink
    ).toBe("forwarded");
  });
});

describe("AAASM-5681: initAssembly surfaces the drop without AA_DEBUG", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.AA_DEBUG;
    vi.resetModules();
  });

  it("WARNS on stderr and reports auditSink=\"discarded\" with AA_DEBUG unset", async () => {
    delete process.env.AA_DEBUG;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const context = await initAssembly({ ...BASE, mode: "auto" });

    expect(stderrText(stderrSpy)).toContain(DISCARD_WARNING_SUBSTRING);
    expect(context.auditSink).toBe("discarded");
    await context.shutdown();
  });

  it("names the escape hatch and the programmatic field, not just the symptom", async () => {
    delete process.env.AA_DEBUG;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const context = await initAssembly({ ...BASE, mode: "auto" });
    const text = stderrText(stderrSpy);

    // A warning that states the problem without stating the remedy sends the
    // reader to the source to find out what to do.
    expect(text).toContain("gatewayClient");
    expect(text).toContain("auditSink");
    await context.shutdown();
  });

  // The enforcement clause has now shipped wrong twice — once claiming
  // enforcement applies everywhere, once claiming the no-op client everywhere.
  // Neither would have reddened any earlier test, because the assertions only
  // looked for "gatewayClient" and "auditSink". These pin the claim per mode.

  it("in napi-inprocess with a loaded binding, does NOT warn at all", async () => {
    // The native binding is not compiled in a bare checkout, so drive the mode
    // the way `create-client-mode-routing.test.ts` does: mock the addon and
    // re-import, which exercises the real `createClient` routing rather than
    // asserting on a hand-built client.
    delete process.env.AA_DEBUG;
    vi.resetModules();
    vi.doMock("node:module", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:module")>();
      return {
        ...actual,
        createRequire: () => () => ({
          connect: vi.fn(async () => ({ id: "handle" })),
          sendEvent: vi.fn(() => undefined),
          queryPolicy: vi.fn(() => ({ decision: "deny", reason: "policy denies" })),
          disconnect: vi.fn(async () => undefined)
        })
      };
    });
    const mod = await import("../src/core/init-assembly.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const context = await mod.initAssembly({
      ...BASE,
      mode: "napi-inprocess",
      enforcementMode: "observe"
    });
    const text = stderrText(stderrSpy);

    // The mocked addon means the binding loaded, so createClient returns a
    // native client whose audit sinks send. There is no drop to disclose, and a
    // warning here would be a false alarm on the one path that does record
    // (AAASM-5750). The `auto` case below is the control: same `initAssembly`,
    // no binding, warning present — so this silence is a decision, not a
    // deleted warning.
    expect(text).not.toContain(DISCARD_WARNING_SUBSTRING);
    expect(context.auditSink).toBe("forwarded");
    await context.shutdown();
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("in auto, DOES say policy checks route through the allow-all no-op client", async () => {
    delete process.env.AA_DEBUG;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const context = await initAssembly({ ...BASE, mode: "auto" });
    const text = stderrText(stderrSpy);

    expect(text).toContain(DISCARD_WARNING_SUBSTRING);
    expect(text).toContain("routes policy checks through the allow-all no-op client");
    expect(text).not.toContain("route through the native runtime");
    await context.shutdown();
  });

  it("does NOT warn, and reports \"caller-supplied\", for a caller's own client", async () => {
    // Negative control: without this the warning assertions above could pass on
    // a build that warns unconditionally, which would be a different lie.
    delete process.env.AA_DEBUG;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const own: GatewayClient = {
      mode: "auto",
      start: async () => undefined,
      close: async () => undefined,
      check: async () => ({ denied: false, pending: false }),
      waitForApproval: async () => ({ denied: false }),
      record: async () => undefined,
      recordResult: async () => undefined,
      scanPrompts: async () => undefined
    };

    const context = await initAssembly({ ...BASE, mode: "auto", gatewayClient: own });

    expect(stderrText(stderrSpy)).not.toContain(DISCARD_WARNING_SUBSTRING);
    // "caller-supplied" is the absence of a claim, not an assurance that the
    // caller's client retains anything.
    expect(context.auditSink).toBe("caller-supplied");
    await context.shutdown();
  });

  it("a caller's client declaring \"discarded\" is told nothing that is false for it", async () => {
    // AAASM-5743. The disposition is honest and the warning is right to fire —
    // this SDK genuinely knows the events go nowhere. What was wrong is WHOSE
    // client it described. `resolveAuditSink` collapses shipped-and-discarding
    // with caller-supplied-and-declared-discarding into one value, so the
    // warning, told only the mode, said the caller's checks route through the
    // allow-all no-op. Measured against a client whose `check` genuinely denies:
    // precisely inverted, for the most sophisticated adopter.
    delete process.env.AA_DEBUG;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    let checked = false;
    const own: GatewayClient = {
      mode: "auto",
      auditSink: "discarded",
      start: async () => undefined,
      close: async () => undefined,
      check: async () => {
        checked = true;
        return { denied: true, pending: false, reason: "MY OWN POLICY DENIES" };
      },
      waitForApproval: async () => ({ denied: true }),
      record: async () => undefined,
      recordResult: async () => undefined,
      scanPrompts: async () => undefined
    };

    const context = await initAssembly({ ...BASE, mode: "auto", gatewayClient: own });
    const text = stderrText(stderrSpy);

    // It still warns — the caller declared the events are dropped.
    expect(text).toContain(DISCARD_WARNING_SUBSTRING);
    expect(context.auditSink).toBe("discarded");

    // Positive control on the client itself: a `check` that is never called
    // cannot falsify a claim about what `check` does, so the deny is driven and
    // observed before the wording is judged.
    await expect(own.check({ toolName: "t", args: {} } as never)).resolves.toMatchObject({
      denied: true
    });
    expect(checked).toBe(true);

    // Neither false sentence may appear.
    expect(text).not.toContain("routes policy checks through the allow-all no-op client");
    expect(text).not.toContain("route through the native runtime");
    expect(text).not.toContain("the gateway client resolved here holds no native event channel");
    expect(text).toContain('the gateway client you supplied declares "auditSink": "discarded"');
    await context.shutdown();
  });

  it("a SHIPPED discarding client still gets the shipped wording — the other direction", async () => {
    // The pin that stops the fix above from being applied unconditionally. It
    // reddens if the caller-supplied branch swallows the shipped one, exactly as
    // the test above reddens if the shipped branch swallows the caller's.
    // Neither passes on the other's coverage (AAASM-5743 AC2).
    delete process.env.AA_DEBUG;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const context = await initAssembly({ ...BASE, mode: "auto" });
    const text = stderrText(stderrSpy);

    expect(text).toContain("the gateway client resolved here holds no native event channel");
    expect(text).toContain("routes policy checks through the allow-all no-op client");
    expect(text).not.toContain("the gateway client you supplied declares");
    expect(context.auditSink).toBe("discarded");
    await context.shutdown();
  });
});
