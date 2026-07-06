/**
 * AAASM-4172 — an OMITTED `enforcementMode` must fail **closed** in the
 * check-capable (`napi-inprocess`) path, matching python (`_local_posture_is
 * _enforce(None) → True`, AAASM-4130) and go (empty mode ≡ enforce). Before
 * this fix `failClosed` was derived from `enforcementMode === "enforce"`, so an
 * agent that opted into in-process enforcement without naming a posture failed
 * OPEN on the three non-authoritative paths (unreachable runtime, UNSPECIFIED
 * verdict, pending-with-no-channel) — a cross-SDK parity gap.
 *
 * The important negative control: `"observe"` / `"disabled"` are explicit
 * non-enforcing postures and MUST stay fail-open.
 */
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/core/init-assembly.js";
import { createNativeGatewayClient } from "../src/gateway/client.js";
import type { NativeClient } from "../src/native/client.js";
import { resolveFailClosed } from "../src/types/enforcement-mode.js";
import { PolicyViolationError } from "../src/errors/policy-violation-error.js";
import { withAssembly } from "../src/wrappers/with-assembly.js";

function fakeNativeClient(queryPolicy: NativeClient["queryPolicy"]): NativeClient {
  return {
    mode: "napi-inprocess",
    close: vi.fn(async () => undefined),
    sendEvent: vi.fn(() => undefined),
    queryPolicy,
    register: vi.fn(async () => "")
  };
}

const throwingRuntime = () => {
  throw new Error("AA_ERR_CONNECT:no runtime listening");
};

describe("resolveFailClosed posture mapping (AAASM-4172)", () => {
  it("treats an omitted posture as fail-closed (py/go parity)", () => {
    expect(resolveFailClosed(undefined)).toBe(true);
  });

  it("treats explicit enforce as fail-closed", () => {
    expect(resolveFailClosed("enforce")).toBe(true);
  });

  it("keeps observe / disabled fail-open (explicit non-enforcing postures)", () => {
    expect(resolveFailClosed("observe")).toBe(false);
    expect(resolveFailClosed("disabled")).toBe(false);
  });
});

describe("createNativeGatewayClient with omitted enforcementMode (AAASM-4172)", () => {
  it("DENY: unreachable runtime denies when the posture is omitted (was allow)", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => throwingRuntime()),
      "agent-1"
      // enforcementMode omitted → defaults to fail-closed
    );

    const decision = await gateway.check({
      action: "tool_call",
      toolName: "delete_all",
      runId: "run-1"
    });
    expect(decision).toEqual({ denied: true, pending: false });

    const executeFn = vi.fn(async () => "should-not-run");
    const tools = { delete_all: { description: "danger", execute: executeFn } };
    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.delete_all.execute()).rejects.toThrow(PolicyViolationError);
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("DENY: a pending verdict with no approval channel denies when omitted (was allow)", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({ denied: false, pending: true, reason: "awaiting approval" })),
      "agent-1"
    );

    const executeFn = vi.fn(async () => "should-not-run-without-approval");
    const tools = { wire_transfer: { description: "money", execute: executeFn } };
    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.wire_transfer.execute()).rejects.toThrow(PolicyViolationError);
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: observe still fails open when the runtime is unreachable", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => throwingRuntime()),
      "agent-1",
      undefined,
      "observe"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "search", runId: "run-2" });
    expect(decision).toEqual({ denied: false, pending: false });
  });

  it("explicit enforce still denies on an unreachable runtime", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => throwingRuntime()),
      "agent-1",
      undefined,
      "enforce"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "delete_all", runId: "run-3" });
    expect(decision).toEqual({ denied: true, pending: false });
  });
});

describe("createClient wires the omitted-posture default through napi-inprocess (AAASM-4172)", () => {
  it("DENY: napi-inprocess + omitted enforcementMode fails closed on an unreachable runtime", async () => {
    const gateway = createClient(
      { gatewayUrl: "https://gateway.example.com", apiKey: "k", agentId: "agent-1", mode: "napi-inprocess" },
      fakeNativeClient(async () => throwingRuntime())
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "delete_all", runId: "run-4" });
    expect(decision).toEqual({ denied: true, pending: false });
  });

  it("NEGATIVE CONTROL: napi-inprocess + observe stays fail-open", async () => {
    const gateway = createClient(
      {
        gatewayUrl: "https://gateway.example.com",
        apiKey: "k",
        agentId: "agent-1",
        mode: "napi-inprocess",
        enforcementMode: "observe"
      },
      fakeNativeClient(async () => throwingRuntime())
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "search", runId: "run-5" });
    expect(decision).toEqual({ denied: false, pending: false });
  });
});
