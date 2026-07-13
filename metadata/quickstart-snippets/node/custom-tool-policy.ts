const tools = withAssembly(
  {
    read_file: {
      execute: async (args: Record<string, unknown>) =>
        readFile(typeof args.path === "string" ? args.path : "").output
    },
    write_file: {
      execute: async (args: Record<string, unknown>) =>
        writeFile(
          typeof args.path === "string" ? args.path : "",
          typeof args.content === "string" ? args.content : ""
        ).output
    }
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "custom-tool-policy-agent" }
);
