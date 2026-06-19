import { describe, expect, expectTypeOf, it } from "vitest";
import { createNoopGatewayClient } from "../../src/gateway/client.js";
import { withAssembly } from "../../src/wrappers/with-assembly.js";

describe("withAssembly", () => {
  it("preserves the exact tool map type", () => {
    const tools = {
      searchWeb: {
        description: "Search the web",
        execute: async (args: { query: string }) => `result:${args.query}`
      },
      sendEmail: {
        description: "Send an email",
        execute: async (args: { to: string; body: string }) => `${args.to}:${args.body}`
      }
    };

    const wrapped = withAssembly(tools, {
      gatewayClient: createNoopGatewayClient("sdk-only"),
      agentId: "agent-1"
    });

    // Compile-time guarantee that withAssembly preserves the exact tool-map type.
    expectTypeOf(wrapped).toEqualTypeOf<typeof tools>();
    expect(wrapped).toBe(tools);
  });
});
