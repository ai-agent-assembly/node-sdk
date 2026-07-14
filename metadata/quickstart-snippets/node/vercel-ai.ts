import { PolicyViolationError, withAssembly } from "@agent-assembly/sdk";
import { createPolicyGatewayClient } from "./policy.js";
import { getWeatherTool, sendEmailTool } from "./tools.js";

// withAssembly wraps each tool's `execute`, keying the policy by the map key.
// The Vercel AI SDK tools run unchanged; only governance is layered on top.
const tools = withAssembly(
  {
    get_weather: getWeatherTool,
    send_email: sendEmailTool,
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "vercel-ai-example-agent" }
);
