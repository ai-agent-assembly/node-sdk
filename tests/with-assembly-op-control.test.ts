import { describe, expect, it, vi } from "vitest";
import { OpTerminatedError } from "../src/errors/op-terminated-error.js";
import { PolicyViolationError } from "../src/errors/policy-violation-error.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { OpControl } from "../src/wrappers/with-assembly.js";
import { withAssembly } from "../src/wrappers/with-assembly.js";

function createMockGateway(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    mode: "sdk-only",
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    check: vi.fn(async () => ({ denied: false, pending: false })),
    waitForApproval: vi.fn(async () => ({ denied: false })),
    record: vi.fn(async () => undefined),
    recordResult: vi.fn(async () => undefined),
    scanPrompts: vi.fn(async () => undefined),
    ...overrides
  };
}

/**
 * Minimal {@link OpControl} stand-in driving `waitForOp` behavior without a live
 * gRPC stream — mirrors the Python companion's `_FakeOpControl`. A terminated
 * op rejects with {@link OpTerminatedError}; a paused op blocks until released.
 */
class FakeOpControl implements OpControl {
  public readonly awaited: string[] = [];
  private readonly terminated: Set<string>;
  private readonly pausedOps: Set<string>;
  private readonly releasers: Array<() => void> = [];

  constructor(opts: { terminated?: string[]; paused?: string[] } = {}) {
    this.terminated = new Set(opts.terminated ?? []);
    this.pausedOps = new Set(opts.paused ?? []);
  }

  async waitForOp(opId: string): Promise<void> {
    this.awaited.push(opId);
    if (this.terminated.has(opId)) {
      throw new OpTerminatedError(`op ${opId} was terminated by the gateway`, opId);
    }
    if (this.pausedOps.has(opId)) {
      await new Promise<void>((resolve) => {
        this.releasers.push(resolve);
      });
    }
  }

  /** Resume all blocked `waitForOp` callers (modelling a gateway RESUME). */
  release(): void {
    const pending = this.releasers.splice(0);
    for (const resolve of pending) resolve();
  }
}

describe("withAssembly op-control kill switch (AAASM-3491)", () => {
  it("TERMINATE: denies the tool BEFORE the gateway is queried (short-circuit)", async () => {
    const gateway = createMockGateway();
    const opControl = new FakeOpControl({ terminated: ["trace-1:span-1"] });
    const executeFn: (input: Record<string, unknown>) => Promise<string> = vi.fn(
      async () => "should not run"
    );
    const tools = {
      search: { description: "Search", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway, opControl });

    await expect(tools.search.execute({ traceId: "trace-1", spanId: "span-1" })).rejects.toThrow(
      PolicyViolationError
    );

    expect(opControl.awaited).toEqual(["trace-1:span-1"]);
    // Short-circuit: a terminated op must halt before the gateway check runs.
    expect(gateway.check).not.toHaveBeenCalled();
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("PAUSE→resume: blocks in waitForOp, then proceeds to the gateway on resume", async () => {
    const gateway = createMockGateway();
    const opControl = new FakeOpControl({ paused: ["trace-2:span-2"] });
    const executeFn: (input: Record<string, unknown>) => Promise<string> = vi.fn(
      async () => "result"
    );
    const tools = {
      search: { description: "Search", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway, opControl });

    let settled = false;
    const call = tools.search
      .execute({ traceId: "trace-2", spanId: "span-2" })
      .then((value) => {
        settled = true;
        return value;
      });

    // Yield: while paused the gateway must NOT have been queried and the tool
    // must NOT have run.
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(gateway.check).not.toHaveBeenCalled();
    expect(executeFn).not.toHaveBeenCalled();

    opControl.release();
    const result = await call;

    expect(result).toBe("result");
    expect(gateway.check).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
    expect(opControl.awaited).toEqual(["trace-2:span-2"]);
  });

  it("NO trace identity: skips op-control and proceeds normally", async () => {
    const gateway = createMockGateway();
    const opControl = new FakeOpControl({ terminated: ["trace-x:span-x"] });
    const executeFn: (input: Record<string, unknown>) => Promise<string> = vi.fn(
      async () => "result"
    );
    const tools = {
      search: { description: "Search", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway, opControl });

    const result = await tools.search.execute({ query: "hello" });

    expect(result).toBe("result");
    expect(opControl.awaited).toEqual([]);
    expect(gateway.check).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it("op_id resolution: explicit opId wins; otherwise composes traceId:spanId", async () => {
    const gateway = createMockGateway();
    const opControl = new FakeOpControl();
    const exec: () => (input: Record<string, unknown>) => Promise<string> = () =>
      vi.fn(async () => "ok");
    const tools = {
      explicit: { description: "t", execute: exec() },
      composed: { description: "t", execute: exec() },
      traceOnly: { description: "t", execute: exec() }
    };

    withAssembly(tools, { gatewayClient: gateway, opControl });

    await tools.explicit.execute({ opId: "explicit-id", traceId: "t", spanId: "s" });
    await tools.composed.execute({ traceId: "trace-9", spanId: "span-9" });
    await tools.traceOnly.execute({ traceId: "trace-only" });

    expect(opControl.awaited).toEqual(["explicit-id", "trace-9:span-9", "trace-only:"]);
  });

  it("no opControl wired: tool path is unchanged (gateway check only)", async () => {
    const gateway = createMockGateway();
    const executeFn: (input: Record<string, unknown>) => Promise<string> = vi.fn(
      async () => "result"
    );
    const tools = {
      search: { description: "Search", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    const result = await tools.search.execute({ traceId: "trace-1", spanId: "span-1" });

    expect(result).toBe("result");
    expect(gateway.check).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it("invoke path: TERMINATE denies the LangChain-style invoke before the gateway", async () => {
    const gateway = createMockGateway();
    const opControl = new FakeOpControl({ terminated: ["trace-3:span-3"] });
    const invokeFn: (input: Record<string, unknown>) => Promise<string> = vi.fn(
      async () => "should not run"
    );
    const tools = {
      lcTool: { name: "lcTool", invoke: invokeFn }
    };

    withAssembly(tools, { gatewayClient: gateway, opControl });

    await expect(tools.lcTool.invoke({ traceId: "trace-3", spanId: "span-3" })).rejects.toThrow(
      PolicyViolationError
    );

    expect(gateway.check).not.toHaveBeenCalled();
    expect(invokeFn).not.toHaveBeenCalled();
  });
});
