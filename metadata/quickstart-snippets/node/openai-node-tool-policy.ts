const tools = withAssembly(
  {
    search_web: {
      execute: async (args: Record<string, unknown>) =>
        searchWeb(typeof args.query === "string" ? args.query : "").output
    },
    send_email: {
      execute: async (args: Record<string, unknown>) =>
        sendEmail(
          typeof args.to === "string" ? args.to : "",
          typeof args.subject === "string" ? args.subject : ""
        ).output
    }
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "openai-node-example-agent" }
);
