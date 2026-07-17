import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, tool } from "@openai/agents";
import type { GatewayClient } from "../src/gateway/client.js";
import {
  openAIAgentsPatchState,
  patchOpenAIAgents,
  unpatchOpenAIAgents
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
});
