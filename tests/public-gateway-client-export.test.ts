import { describe, expect, it } from "vitest";
import { createNoopGatewayClient, withAssembly } from "../src/index.js";

describe("public gateway client export", () => {
  it("ALLOW: withAssembly governs a tool offline via the public noop client", async () => {
    const gatewayClient = createNoopGatewayClient("sdk-only");
    const tools = {
      search: {
        description: "Search",
        execute: async (args: { query: string }) => `result:${args.query}`
      }
    };

    withAssembly(tools, { gatewayClient });
    const result = await tools.search.execute({ query: "hello" });

    expect(result).toBe("result:hello");
  });
});
