// withAssembly wraps each tool's `execute`, keying the policy by the map key.
// The Vercel AI SDK tools run unchanged; only governance is layered on top.
const tools = withAssembly(
  {
    get_weather: getWeatherTool,
    send_email: sendEmailTool,
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "vercel-ai-example-agent" }
);
