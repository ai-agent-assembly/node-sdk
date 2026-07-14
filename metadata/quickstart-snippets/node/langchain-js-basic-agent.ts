import { withAssembly } from "@agent-assembly/sdk";
import { createPolicyGatewayClient } from "./policy.js";
import { TOOLS } from "./tools.js";

const tools = withAssembly(
  {
    get_weather: {
      execute: async (args: Record<string, unknown>) => TOOLS.get_weather(args).output
    },
    delete_file: {
      execute: async (args: Record<string, unknown>) => TOOLS.delete_file(args).output
    }
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "langchain-js-example-agent" }
);
