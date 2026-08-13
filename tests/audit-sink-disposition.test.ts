/**
 * AAASM-5681 — a shipped gateway client must not discard hook-layer audit
 * events silently.
 *
 * `record` / `recordResult` / `scanPrompts` all return `Promise<void>`, so a
 * client that retains the event and a client that drops it are
 * indistinguishable to the caller. Both clients this package ships drop it, and
 * before this suite the only signal was a one-shot note gated on `AA_DEBUG=1` —
 * a caller had to already suspect the problem to discover it.
 *
 * The suite pins three separate things, because any one of them alone can pass
 * while the defect is present:
 *
 *  1. Every shipped client *declares* an `auditSink` disposition.
 *  2. The declaration matches what the client actually does — a client that
 *     says `"discarded"` must reach nothing, measured against a boundary that
 *     is proven reachable by a positive control.
 *  3. `initAssembly` surfaces the drop on the DEFAULT path, with `AA_DEBUG`
 *     unset, both on stderr and programmatically as `context.auditSink`.
 *
 * Assertions here are over the real shipped clients. The `NativeClient` stub is
 * not a stand-in for the code under test — it is the downstream boundary, and
 * the point is to prove nothing crosses it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeGatewayClient, createNoopGatewayClient } from "../src/gateway/index.js";
import { createClient, initAssembly } from "../src/core/init-assembly.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { NativeClient } from "../src/native/client.js";

const BASE = {
  gatewayUrl: "https://gateway.example.com",
  apiKey: "k",
  agentId: "agent-1"
} as const;

const DISCARD_WARNING_SUBSTRING = "hook-layer audit events are DISCARDED";

/** Records every crossing of the native boundary. */
function boundary(): { native: NativeClient; crossings: string[] } {
  const crossings: string[] = [];
  const native = {
    queryPolicy: async (query: unknown) => {
      crossings.push(`queryPolicy:${JSON.stringify(query)}`);
      return { denied: false, pending: false };
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
 * Every gateway-client factory this package ships. A new shipped client must be
 * added here — that is the point: an undeclared discarding client should fail
 * this suite rather than ship silently.
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

  it.each(SHIPPED_CLIENTS)("$name declares an auditSink disposition", ({ build }) => {
    // An omitted disposition reads as "caller-supplied" — the absence of a
    // claim. A client this package ships must never be in that state: it would
    // let a discarding sink present as one the SDK cannot speak for.
    expect(build().auditSink).toBeDefined();
    expect(build().auditSink).toBe("discarded");
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

  it("a client declaring \"discarded\" reaches nothing with any audit method", async () => {
    const { native, crossings } = boundary();
    const client = createNativeGatewayClient("napi-inprocess", native, "agent-1");
    expect(client.auditSink).toBe("discarded");

    await client.record({ action: "tool_call", runId: "r1", reason: "denied" });
    await client.recordResult({ runId: "r1", output: "SENSITIVE-RESULT" });
    await client.scanPrompts({ prompts: ["a prompt"], runId: "r1" });

    expect(crossings).toEqual([]);
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

  it("createClient resolves a shipped, discarding client on the default path", () => {
    // Guards the wiring: if `createClient` ever returned something undeclared,
    // `initAssembly` would silently stop warning.
    expect(createClient({ ...BASE, mode: "auto" }).auditSink).toBe("discarded");
    expect(
      createClient({ ...BASE, mode: "napi-inprocess", enforcementMode: "observe" }, boundary().native)
        .auditSink
    ).toBe("discarded");
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
});
