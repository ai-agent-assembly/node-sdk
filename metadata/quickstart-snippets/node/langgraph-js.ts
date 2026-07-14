import { PolicyViolationError, withAssembly } from "@agent-assembly/sdk";
import { createPolicyGatewayClient } from "./policy.js";
import { TOOLS } from "./tools.js";

/**
 * Build governed tools once, then call them from inside graph nodes.
 * withAssembly enforces the local policy before each tool runs.
 */
function buildGovernedTools() {
  return withAssembly(
    {
      search_docs: {
        execute: async (args: Record<string, unknown>) => TOOLS.search_docs(args).output,
      },
      execute_shell: {
        execute: async (args: Record<string, unknown>) => TOOLS.execute_shell(args).output,
      },
    },
    { gatewayClient: createPolicyGatewayClient(), agentId: "langgraph-js-example-agent" }
  );
}
