import { describe, expect, it, vi } from "vitest";
import { PolicyViolationError } from "../src/errors/policy-violation-error.js";
import { createNativeGatewayClient } from "../src/gateway/client.js";
import type { NativeClient } from "../src/native/client.js";
import { withAssembly } from "../src/wrappers/with-assembly.js";

/**
 * AAASM-3050 — end-to-end wiring of `withAssembly`'s tool check through the
 * native gateway client to a (mocked) runtime's `queryPolicy`.
 *
 * The native binding is not loaded here; instead a fake `NativeClient` stands
 * in for the runtime so the wrapper → gateway → native contract can be
 * exercised on every platform. The shared enforcement contract is verified:
 * a reachable runtime DENY blocks the tool; an unreachable / silent runtime
 * fails open and the tool proceeds.
 */
function fakeNativeClient(queryPolicy: NativeClient["queryPolicy"]): NativeClient {
  return {
    mode: "napi-inprocess",
    close: vi.fn(async () => undefined),
    sendEvent: vi.fn(() => undefined),
    queryPolicy,
    register: vi.fn(async () => "")
  };
}

describe("native gateway enforcement (AAASM-3050)", () => {
  it("DENY: a reachable runtime deny blocks the tool and never runs its body", async () => {
    const queryPolicy = vi.fn(async () => ({
      denied: true,
      pending: false,
      reason: "egress policy: blocked"
    }));
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(queryPolicy),
      "agent-1"
    );

    const executeFn = vi.fn(async (args: { path: string }) => `ran:${args.path}`);
    const tools = { delete_all: { description: "danger", execute: executeFn } };
    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.delete_all.execute({ path: "/" })).rejects.toThrow(PolicyViolationError);
    await expect(tools.delete_all.execute({ path: "/" })).rejects.toThrow("egress policy: blocked");
    expect(executeFn).not.toHaveBeenCalled();

    // The native query carries the shared contract fields.
    expect(queryPolicy).toHaveBeenCalledWith({
      agent_id: "agent-1",
      action_type: "tool_call",
      tool_name: "delete_all",
      args: [{ path: "/" }]
    });
  });

  it("ALLOW: a reachable runtime allow lets the tool run", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({ denied: false, pending: false })),
      "agent-1"
    );

    const executeFn = vi.fn(async (args: { q: string }) => `ran:${args.q}`);
    const tools = { search: { description: "search", execute: executeFn } };
    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.search.execute({ q: "hi" })).resolves.toBe("ran:hi");
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it("FAIL-OPEN: no runtime (native query rejects) lets the tool proceed", async () => {
    // The native primitive already returns "allow" when the runtime is
    // unreachable; on top of that, even a hard local fault must fail open.
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => {
        throw new Error("AA_ERR_CONNECT:no runtime listening");
      }),
      "agent-1"
    );

    const executeFn = vi.fn(async () => "ran-without-runtime");
    const tools = { send_email: { description: "email", execute: executeFn } };
    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.send_email.execute()).resolves.toBe("ran-without-runtime");
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it("FAIL-CLOSED: under enforce, an unreachable runtime denies the tool (AAASM-3996)", async () => {
    // py/go parity (AAASM-3920): when the caller opts into enforce, a caught
    // local fault / unreachable runtime must deny rather than fail open, so a
    // stalled or killed sidecar cannot downgrade deny-on-failure to allow.
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => {
        throw new Error("AA_ERR_CONNECT:no runtime listening");
      }),
      "agent-1",
      undefined,
      "enforce"
    );

    // The gateway decision itself denies on fault under enforce.
    const decision = await gateway.check({ action: "tool_call", toolName: "delete_all", runId: "run-1" });
    expect(decision).toEqual({ denied: true, pending: false });

    // End-to-end: the wrapper blocks the tool and never runs its body.
    const executeFn = vi.fn(async () => "should-not-run");
    const tools = { delete_all: { description: "danger", execute: executeFn } };
    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.delete_all.execute()).rejects.toThrow(PolicyViolationError);
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("ADVISORY: under observe, an unreachable runtime still fails open", async () => {
    // Non-enforce postures keep the advisory fail-open: a missing runtime must
    // not block the agent.
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => {
        throw new Error("AA_ERR_CONNECT:no runtime listening");
      }),
      "agent-1",
      undefined,
      "observe"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "search", runId: "run-2" });
    expect(decision).toEqual({ denied: false, pending: false });
  });

  it("defaults denied/pending to false and omits reason when the verdict is bare", async () => {
    // A verdict object with no denied/pending/reason exercises the `?? false`
    // fallbacks and the reason-omission branch.
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({}) as Awaited<ReturnType<NativeClient["queryPolicy"]>>),
      "agent-bare"
    );

    const decision = await gateway.check({ action: "tool_call", toolName: "noop", runId: "run-bare" });

    expect(decision).toEqual({ denied: false, pending: false });
    expect(decision).not.toHaveProperty("reason");
  });

  it("close() delegates to the native client's close", async () => {
    const native = fakeNativeClient(async () => ({ denied: false, pending: false }));
    const gateway = createNativeGatewayClient("napi-inprocess", native, "agent-close");

    await gateway.close();

    expect(native.close).toHaveBeenCalledOnce();
  });

  it("PENDING: a runtime pending verdict routes to the approval path", async () => {
    const gateway = createNativeGatewayClient(
      "napi-inprocess",
      fakeNativeClient(async () => ({
        denied: false,
        pending: true,
        reason: "awaiting approval"
      })),
      "agent-1"
    );

    const executeFn = vi.fn(async () => "approved-and-ran");
    const tools = { wire_transfer: { description: "money", execute: executeFn } };
    // No approval push is wired in the node SDK yet, so the noop approval path
    // resolves to "not denied" and the tool proceeds (per the shared contract).
    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.wire_transfer.execute()).resolves.toBe("approved-and-ran");
    expect(executeFn).toHaveBeenCalledOnce();
  });
});
