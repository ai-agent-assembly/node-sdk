// Wrap the Mastra tools with withAssembly. Each governed entry delegates to the
// real Mastra tool's execute, so the policy is enforced before the tool runs.
const tools = withAssembly(
  {
    get_stock_price: {
      execute: async (args: Record<string, unknown>) => runMastraTool(getStockPriceTool, args),
    },
    place_trade: {
      execute: async (args: Record<string, unknown>) => runMastraTool(placeTradeTool, args),
    },
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "mastra-example-agent" }
);
