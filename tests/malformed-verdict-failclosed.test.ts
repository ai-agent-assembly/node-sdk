import { describe, expect, it, vi } from "vitest";
import { createNativeGatewayClient, resolveVerdict } from "../src/gateway/client.js";
import type { NativeClient } from "../src/native/client.js";

/**
 * AAASM-4798 — a verdict/approval result that RESOLVES with no recognizable
 * `denied` / `pending` signal (`{}`, `{ denied: undefined }`, or a
 * version-skewed native response with the wrong field types) must fail closed
 * under enforce, not silently allow via `?? false`. This is distinct from the
 * already-covered catch-block fault path (a THROWN error) exercised in
 * `native-gateway-enforcement.test.ts`.
 */
function fakeNativeClient(queryPolicy: NativeClient["queryPolicy"]): NativeClient {
  return {
    mode: "napi-inprocess",
    canRegister: true,
    close: vi.fn(async () => undefined),
    sendEvent: vi.fn(() => undefined),
    queryPolicy,
    register: vi.fn(async () => "")
  };
}

describe("check(): resolved-but-malformed verdict fails closed under enforce (AAASM-4798)", () => {
  it.each([
    ["empty object", {}],
    ["denied explicitly undefined", { denied: undefined }],
    ["pending explicitly undefined", { pending: undefined }],
    ["wrong-type denied (version-skewed native response)", { denied: "nope" }],
    ["wrong-type pending", { pending: "maybe" }]
  ])("denies under the default (omitted) enforce posture: %s", async (_label, malformed) => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => malformed as Awaited<ReturnType<NativeClient["queryPolicy"]>>),
      "agent-malformed"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "run-1" });

    expect(decision.denied).toBe(true);
    expect(decision.pending).toBe(false);
  });

  it("denies under explicit enforce", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({}) as Awaited<ReturnType<NativeClient["queryPolicy"]>>),
      "agent-malformed",
      undefined,
      "enforce"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "run-2" });

    expect(decision).toEqual({
      denied: true,
      pending: false,
      reason: "malformed policy verdict: no recognizable denied/pending signal"
    });
  });

  it("preserves an existing reason string on an otherwise-malformed verdict", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(
        async () =>
          ({ reason: "runtime returned partial payload" }) as Awaited<
            ReturnType<NativeClient["queryPolicy"]>
          >
      ),
      "agent-malformed",
      undefined,
      "enforce"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "run-3" });

    expect(decision).toEqual({
      denied: true,
      pending: false,
      reason: "runtime returned partial payload"
    });
  });

  it.each(["observe", "disabled"] as const)(
    "stays allow under the non-enforcing posture %s",
    async (enforcementMode) => {
      const gateway = createNativeGatewayClient(
        "napi-inprocess",
        fakeNativeClient(async () => ({}) as Awaited<ReturnType<NativeClient["queryPolicy"]>>),
        "agent-malformed",
        undefined,
        enforcementMode
      );

      const decision = await gateway.check({
        action: "tool_call",
        toolName: "noop",
        runId: "run-4"
      });

      expect(decision).toEqual({ denied: false, pending: false });
      expect(decision).not.toHaveProperty("reason");
    }
  );

  it("leaves a well-formed deny verdict unchanged", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({ denied: true, pending: false, reason: "blocked" })),
      "agent-wellformed",
      undefined,
      "enforce"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "run-5" });

    expect(decision).toEqual({ denied: true, pending: false, reason: "blocked" });
  });

  it("leaves a well-formed allow verdict unchanged", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({ denied: false, pending: false })),
      "agent-wellformed",
      undefined,
      "enforce"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "run-6" });

    expect(decision).toEqual({ denied: false, pending: false });
  });

  it("leaves a well-formed pending verdict unchanged", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({ denied: false, pending: true, reason: "awaiting approval" })),
      "agent-wellformed",
      undefined,
      "enforce"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "run-7" });

    expect(decision).toEqual({ denied: false, pending: true, reason: "awaiting approval" });
  });
});

/**
 * `waitForApproval()`'s own result is a hardcoded literal today (no real
 * approval channel is wired — AAASM-4129) so it cannot itself resolve with a
 * malformed shape through the public API. `resolveVerdict` is the exact same
 * guard `check()` uses for its resolved verdict, exported so it can be
 * exercised directly against a `GatewayApprovalResult`-shaped payload,
 * proving a future real approval channel would inherit the fail-closed
 * guarantee rather than a fresh `?? false`.
 */
describe("resolveVerdict(): malformed approval result fails closed under enforce (AAASM-4798)", () => {
  it.each([
    ["empty object", {}],
    ["denied explicitly undefined", { denied: undefined }],
    ["wrong-type denied", { denied: "nope" }]
  ])("denies under failClosed=true (enforce): %s", (_label, malformedApproval) => {
    const resolved = resolveVerdict(malformedApproval, true);

    expect(resolved.denied).toBe(true);
  });

  it.each([
    ["empty object", {}],
    ["denied explicitly undefined", { denied: undefined }]
  ])("stays allow under failClosed=false (observe/disabled): %s", (_label, malformedApproval) => {
    const resolved = resolveVerdict(malformedApproval, false);

    expect(resolved.denied).toBe(false);
  });

  it("leaves a well-formed denied approval result unchanged", () => {
    expect(resolveVerdict({ denied: true, reason: "rejected by approver" }, true)).toEqual({
      denied: true,
      pending: false,
      reason: "rejected by approver"
    });
  });

  it("leaves a well-formed allowed approval result unchanged", () => {
    expect(resolveVerdict({ denied: false }, true)).toEqual({ denied: false, pending: false });
  });
});
