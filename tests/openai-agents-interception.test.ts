import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, tool } from "@openai/agents";
import type { GatewayClient } from "../src/gateway/client.js";
import {
  openAIAgentsPatchState,
  patchOpenAIAgents,
  unpatchOpenAIAgents,
  wrapFunctionToolInvoke
} from "../src/hooks/openai-agents.js";

/**
 * End-to-end interception proof (AAASM-4797).
 *
 * Drives the real `@openai/agents` >= 0.8.x objects through the `getAllTools`
 * hook: a tool is created via the real `tool()` factory, attached to a real
 * `Agent`, and executed by calling `agent.getAllTools(...)` then the returned
 * tool's `invoke(...)` — the exact path `@openai/agents-core`'s tool runner
 * takes. This proves a policy DENY actually blocks the tool through the new hook,
 * not just that the patch reports success.
 */
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

const runContext = { context: {}, usage: {} };

function buildTool(executed: { called: boolean }) {
  return tool({
    name: "send_email",
    description: "Send an email",
    parameters: {
      type: "object",
      properties: { to: { type: "string" } },
      required: ["to"],
      additionalProperties: false
    },
    execute: async () => {
      executed.called = true;
      return "SENT";
    }
  });
}

afterEach(() => {
  unpatchOpenAIAgents();
  openAIAgentsPatchState.originalRunTool = undefined;
  openAIAgentsPatchState.originalGetAllTools = undefined;
  openAIAgentsPatchState.hookPoint = undefined;
  openAIAgentsPatchState.patchedAgentClass = undefined;
  openAIAgentsPatchState.isPatched = false;
});

describe("openai agents interception via getAllTools", () => {
  it("attaches to the getAllTools hook point", async () => {
    const gateway = createGatewayClientMock();
    const patched = await patchOpenAIAgents({
      gatewayClient: gateway,
      loadAgentClass: async () => Agent as never
    });
    expect(patched).toBe(true);
    expect(openAIAgentsPatchState.hookPoint).toBe("getAllTools");
  });

  it("blocks a governed tool call under a DENY verdict without executing it", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "policy-blocked" }));

    await patchOpenAIAgents({
      gatewayClient: gateway,
      loadAgentClass: async () => Agent as never
    });

    const executed = { called: false };
    const emailTool = buildTool(executed);
    const agent = new Agent({ name: "A", instructions: "x", tools: [emailTool] });

    const tools = await agent.getAllTools(runContext as never);
    const governed = tools.find((t) => (t as { name?: string }).name === "send_email") as {
      invoke: (rc: unknown, input: string) => Promise<unknown>;
    };

    const output = await governed.invoke(runContext, JSON.stringify({ to: "user@example.com" }));

    expect(output).toBe("Blocked by governance policy: policy-blocked");
    expect(executed.called).toBe(false);
    expect(gateway.check).toHaveBeenCalledWith({
      action: "tool_call",
      toolName: "send_email",
      args: { to: "user@example.com" },
      runId: "openai-agents"
    });
  });

  it("runs the original tool under an ALLOW verdict", async () => {
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: false, pending: false }));

    await patchOpenAIAgents({
      gatewayClient: gateway,
      loadAgentClass: async () => Agent as never
    });

    const executed = { called: false };
    const emailTool = buildTool(executed);
    const agent = new Agent({ name: "A", instructions: "x", tools: [emailTool] });

    const tools = await agent.getAllTools(runContext as never);
    const governed = tools.find((t) => (t as { name?: string }).name === "send_email") as {
      invoke: (rc: unknown, input: string) => Promise<unknown>;
    };

    const output = await governed.invoke(runContext, JSON.stringify({ to: "user@example.com" }));

    expect(output).toBe("SENT");
    expect(executed.called).toBe(true);
  });

  it("guards a frozen tool: warns without rejecting getAllTools or breaking siblings", async () => {
    // AAASM-4847: a frozen function-tool object makes the `invoke` assignment
    // throw in strict mode. Because the wrap runs inside patchedGetAllTools on
    // every turn, an unguarded throw would reject getAllTools and break the
    // whole agent. The guard must skip+warn on the frozen tool while still
    // governing the writable siblings.
    const gateway = createGatewayClientMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await patchOpenAIAgents({
      gatewayClient: gateway,
      loadAgentClass: async () => Agent as never
    });

    const frozenExecuted = { called: false };
    const writableExecuted = { called: false };
    const frozenTool = Object.freeze(buildTool(frozenExecuted));
    const writableTool = tool({
      name: "list_files",
      description: "List files",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        writableExecuted.called = true;
        return "LISTED";
      }
    });
    const agent = new Agent({ name: "A", instructions: "x", tools: [frozenTool, writableTool] });

    // The whole point: getAllTools must resolve, not reject, despite the frozen tool.
    const tools = await agent.getAllTools(runContext as never);

    try {
      const warned = stderr.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("send_email") && line.includes("AAASM-4847"));
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }

    // The writable sibling is still governed (its invoke was wrapped).
    const writable = tools.find((t) => (t as { name?: string }).name === "list_files") as {
      invoke: (rc: unknown, input: string) => Promise<unknown>;
    };
    await writable.invoke(runContext, JSON.stringify({}));
    expect(gateway.check).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "list_files" })
    );
  });

  it("wraps a sealed-but-writable tool: DENY is enforced (AAASM-4951)", async () => {
    // AAASM-4951: `Object.seal()` makes the tool non-extensible but leaves its
    // `invoke` data property writable:true, so `candidate.invoke = wrapper`
    // succeeds. The guard must not skip on non-extensibility alone — doing so
    // silently left a sealed tool ungoverned despite a wrappable seam.
    const gateway = createGatewayClientMock();
    gateway.check = vi.fn(async () => ({ denied: true, reason: "policy-blocked" }));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await patchOpenAIAgents({
      gatewayClient: gateway,
      loadAgentClass: async () => Agent as never
    });

    const executed = { called: false };
    const sealedTool = Object.seal(buildTool(executed));
    expect(Object.isExtensible(sealedTool)).toBe(false);
    const agent = new Agent({ name: "A", instructions: "x", tools: [sealedTool] });

    const tools = await agent.getAllTools(runContext as never);
    const governed = tools.find((t) => (t as { name?: string }).name === "send_email") as {
      invoke: (rc: unknown, input: string) => Promise<unknown>;
    };
    const output = await governed.invoke(runContext, JSON.stringify({ to: "user@example.com" }));

    try {
      // Enforcement applied: DENY blocked execution, and no not-wrappable warning fired.
      expect(output).toBe("Blocked by governance policy: policy-blocked");
      expect(executed.called).toBe(false);
      const warned = stderr.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("send_email") && line.includes("could not be wrapped"));
      expect(warned).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("skips a non-extensible tool whose own invoke slot is absent (AAASM-4951)", () => {
    // AAASM-4951: exercises the absent-own-slot branch of the inline
    // writability check (`Object.getOwnPropertyDescriptor(candidate, "invoke")
    // === undefined`), which only the add-property case reaches. Here `invoke`
    // is inherited from the prototype, so the own descriptor is undefined and
    // wrapping would have to *add* an own `invoke` — impossible on a
    // non-extensible object, so the guard must skip + warn (mirrors the
    // extensible sub-case, where adding the property would instead succeed).
    const gateway = createGatewayClientMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const proto = { invoke: async () => "PROTO" };
    const inheritedInvokeTool = Object.create(proto) as { type: string; name: string };
    inheritedInvokeTool.type = "function";
    inheritedInvokeTool.name = "inherited_invoke_tool";
    Object.preventExtensions(inheritedInvokeTool);
    // Precondition: own `invoke` slot is absent, object is non-extensible.
    expect(Object.getOwnPropertyDescriptor(inheritedInvokeTool, "invoke")).toBeUndefined();
    expect(Object.isExtensible(inheritedInvokeTool)).toBe(false);

    try {
      expect(() =>
        wrapFunctionToolInvoke(inheritedInvokeTool, gateway, {
          fallbackRunId: "run-inherited",
          approvalTimeoutMs: 100
        })
      ).not.toThrow();
      // Not wrapped: no own `invoke` was added, and a not-wrappable warning fired.
      expect(Object.getOwnPropertyDescriptor(inheritedInvokeTool, "invoke")).toBeUndefined();
      const warned = stderr.mock.calls
        .map((call) => String(call[0]))
        .some(
          (line) => line.includes("inherited_invoke_tool") && line.includes("could not be wrapped")
        );
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("guards an extensible tool whose invoke is non-writable: warns without rejecting", async () => {
    // AAASM-4847: the object is extensible but its `invoke` slot is a
    // non-writable data property, so the assignment still throws. This
    // exercises the descriptor branch of the writability guard that a fully
    // frozen object short-circuits before reaching.
    const gateway = createGatewayClientMock();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await patchOpenAIAgents({
      gatewayClient: gateway,
      loadAgentClass: async () => Agent as never
    });

    const executed = { called: false };
    const nonWritableTool = buildTool(executed) as { invoke: unknown; name?: string };
    Object.defineProperty(nonWritableTool, "invoke", {
      value: nonWritableTool.invoke,
      writable: false,
      configurable: true,
      enumerable: true
    });
    expect(Object.isExtensible(nonWritableTool)).toBe(true);
    const agent = new Agent({ name: "A", instructions: "x", tools: [nonWritableTool as never] });

    const tools = await agent.getAllTools(runContext as never);

    try {
      const warned = stderr.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("send_email") && line.includes("AAASM-4847"));
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
    // getAllTools still resolved despite the non-writable invoke.
    expect(Array.isArray(tools)).toBe(true);
  });
});
