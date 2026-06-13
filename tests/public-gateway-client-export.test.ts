import { describe, expect, it } from "vitest";
import { createNoopGatewayClient, PolicyViolationError, withAssembly } from "../src/index.js";
import type { GatewayClient } from "../src/index.js";

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

  it("DENY: a custom public GatewayClient blocks a tool offline", async () => {
    const blocked = new Set(["delete_file"]);
    const gatewayClient: GatewayClient = {
      mode: "sdk-only",
      start: async () => undefined,
      close: async () => undefined,
      check: async (request) =>
        request.toolName !== undefined && blocked.has(request.toolName)
          ? { denied: true, reason: "blocked by local policy" }
          : { denied: false },
      waitForApproval: async () => ({ denied: false }),
      record: async () => undefined,
      recordResult: async () => undefined,
      scanPrompts: async () => undefined
    };
    const tools = {
      delete_file: { description: "Delete a file", execute: async () => "deleted" }
    };

    withAssembly(tools, { gatewayClient });

    await expect(tools.delete_file.execute()).rejects.toBeInstanceOf(PolicyViolationError);
  });
});
