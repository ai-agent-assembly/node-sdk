import { describe, expect, it, vi } from "vitest";
import { PolicyViolationError } from "../src/errors/policy-violation-error.js";
import type { GatewayClient } from "../src/gateway/client.js";
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

describe("withAssembly governance", () => {
  it("ALLOW: passes through to original execute when gateway allows", async () => {
    const gateway = createMockGateway();
    const executeFn = vi.fn(async (args: { query: string }) => `result:${args.query}`);
    const tools = {
      search: { description: "Search", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    const result = await tools.search.execute({ query: "hello" });

    expect(gateway.check).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledWith({ query: "hello" });
    expect(result).toBe("result:hello");
  });

  it("DENY: throws PolicyViolationError when gateway denies", async () => {
    const gateway = createMockGateway({
      check: vi.fn(async () => ({ denied: true, pending: false, reason: "policy X" }))
    });
    const executeFn = vi.fn(async () => "should not run");
    const tools = {
      dangerous: { description: "Dangerous tool", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.dangerous.execute()).rejects.toThrow(PolicyViolationError);
    await expect(tools.dangerous.execute()).rejects.toThrow("Tool 'dangerous' blocked: policy X");
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("PENDING→approve: waits for approval then executes", async () => {
    const gateway = createMockGateway({
      check: vi.fn(async () => ({ denied: false, pending: true })),
      waitForApproval: vi.fn(async () => ({ denied: false }))
    });
    const executeFn = vi.fn(async () => "approved-result");
    const tools = {
      sensitive: { description: "Sensitive tool", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    const result = await tools.sensitive.execute();

    expect(gateway.waitForApproval).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
    expect(result).toBe("approved-result");
  });

  it("PENDING→deny: throws PolicyViolationError when approval is rejected", async () => {
    const gateway = createMockGateway({
      check: vi.fn(async () => ({ denied: false, pending: true })),
      waitForApproval: vi.fn(async () => ({ denied: true, reason: "Manager rejected" }))
    });
    const executeFn = vi.fn(async () => "should not run");
    const tools = {
      sensitive: { description: "Sensitive tool", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.sensitive.execute()).rejects.toThrow(PolicyViolationError);
    await expect(tools.sensitive.execute()).rejects.toThrow(
      "Approval rejected for 'sensitive': Manager rejected"
    );
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("PENDING→timeout: throws PolicyViolationError on approval timeout", async () => {
    const gateway = createMockGateway({
      check: vi.fn(async () => ({ denied: false, pending: true })),
      waitForApproval: vi.fn(
        () => new Promise<{ denied: boolean }>((resolve) => {
          setTimeout(() => resolve({ denied: false }), 5000);
        })
      )
    });
    const executeFn = vi.fn(async () => "should not run");
    const tools = {
      slow: { description: "Slow approval tool", execute: executeFn }
    };

    withAssembly(tools, { gatewayClient: gateway, approvalTimeoutMs: 50 });

    await expect(tools.slow.execute()).rejects.toThrow(PolicyViolationError);
    await expect(tools.slow.execute()).rejects.toThrow("Approval timeout after 50ms");
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("invoke method: wraps LangChain-style invoke with governance", async () => {
    const gateway = createMockGateway({
      check: vi.fn(async () => ({ denied: true, pending: false, reason: "blocked" }))
    });
    const invokeFn: (input: string) => Promise<string> = vi.fn(async () => "should not run");
    const tools = {
      lcTool: { name: "lcTool", invoke: invokeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.lcTool.invoke("input")).rejects.toThrow(PolicyViolationError);
    await expect(tools.lcTool.invoke("input")).rejects.toThrow(
      "Tool 'lcTool' blocked: blocked"
    );
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("invoke PENDING→approve: waits for approval then invokes the original", async () => {
    const gateway = createMockGateway({
      check: vi.fn(async () => ({ denied: false, pending: true })),
      waitForApproval: vi.fn(async () => ({ denied: false }))
    });
    const invokeFn: (input: string) => Promise<string> = vi.fn(async () => "invoke-approved");
    const tools = {
      lcTool: { name: "lcTool", invoke: invokeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    const result = await tools.lcTool.invoke("input");

    expect(gateway.waitForApproval).toHaveBeenCalledOnce();
    expect(invokeFn).toHaveBeenCalledWith("input");
    expect(result).toBe("invoke-approved");
  });

  it("invoke PENDING→deny: throws PolicyViolationError when approval is rejected", async () => {
    const gateway = createMockGateway({
      check: vi.fn(async () => ({ denied: false, pending: true })),
      waitForApproval: vi.fn(async () => ({ denied: true, reason: "Manager rejected" }))
    });
    const invokeFn: (input: string) => Promise<string> = vi.fn(async () => "should not run");
    const tools = {
      lcTool: { name: "lcTool", invoke: invokeFn }
    };

    withAssembly(tools, { gatewayClient: gateway });

    await expect(tools.lcTool.invoke("input")).rejects.toThrow(PolicyViolationError);
    await expect(tools.lcTool.invoke("input")).rejects.toThrow(
      "Approval rejected for 'lcTool': Manager rejected"
    );
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("passthrough: tools without execute or invoke are left unchanged", () => {
    const gateway = createMockGateway();
    const tools = {
      config: { description: "Config-only tool", setting: "value" }
    };

    const originalTool = { ...tools.config };

    withAssembly(tools, { gatewayClient: gateway });

    expect(tools.config.description).toBe(originalTool.description);
    expect(tools.config.setting).toBe(originalTool.setting);
    expect(gateway.check).not.toHaveBeenCalled();
  });

  it("mixed tool map: handles execute, invoke, and plain tools together", async () => {
    const gateway = createMockGateway();
    const executeFn = vi.fn(async () => "execute-result");
    const invokeFn = vi.fn(async () => "invoke-result");
    const tools = {
      vercelTool: { description: "Vercel tool", execute: executeFn },
      langchainTool: { name: "langchainTool", invoke: invokeFn },
      plainTool: { description: "No callable method", data: 42 }
    };

    withAssembly(tools, { gatewayClient: gateway });

    const executeResult = await tools.vercelTool.execute();
    const invokeResult = await tools.langchainTool.invoke();

    expect(executeResult).toBe("execute-result");
    expect(invokeResult).toBe("invoke-result");
    expect(tools.plainTool.data).toBe(42);
    expect(gateway.check).toHaveBeenCalledTimes(2);
  });
});
