---
sidebar_position: 8
---

# Mastra

Source: [`node/mastra`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/mastra)

## What this example demonstrates

Governing tools defined with **[Mastra](https://mastra.ai)'s `createTool`** using
Agent Assembly. Each tool's `execute` is wrapped by `withAssembly()` + a local-policy
`GatewayClient`:

- `get_stock_price` is **allowed** — it executes and returns mock output.
- `place_trade` is **denied** — it is blocked at the policy layer with `PolicyViolationError`.

The governance point: real Mastra tools (defined with `createTool`) can be governed by
wrapping their `execute` through `withAssembly`.

## The framework / library

[Mastra](https://mastra.ai) — the real `@mastra/core` package (version `^1.0.0` in
`package.json`), plus `zod` (`^3.25.76`) for the tool schemas and
`@agent-assembly/sdk` (version `0.0.1-beta.5`). It runs fully offline — no provider
key and no live LLM.

## How it works

`src/tools.ts` defines two tools with Mastra's `createTool` (each with `inputSchema`,
`outputSchema`, and a mock `execute`). `src/index.ts` wraps them with `withAssembly`,
delegating each governed entry to the real Mastra tool's `execute` via a small
`runMastraTool` helper (Mastra's signature is `(inputData, context) => ...`; the demo
passes an empty context). Calling the governed `place_trade` triggers a policy deny,
so `withAssembly` throws `PolicyViolationError` before the Mastra tool runs.

## Prerequisites & running it

See [Preparing the runtime environment](./setup.md) for the shared prerequisites.
Then:

```bash
cd node/mastra
pnpm install
pnpm start
```

No gateway or API key required — all tests run offline. To connect to a real gateway,
set `AAASM_GATEWAY_URL` in your environment directly; to drive a real LLM with a Mastra
Agent, set `OPENAI_API_KEY`.

## Code walkthrough

Tools are defined with Mastra's `createTool`:

```ts title="src/tools.ts"
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const getStockPriceTool = createTool({
  id: "get_stock_price",
  description: "Look up the latest price for a stock ticker.",
  inputSchema: z.object({ ticker: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ ticker }) => ({ text: `${ticker}: $123.45 [mock]` }),
});
```

`index.ts` wraps the Mastra tools and delegates to their real `execute`:

```ts title="src/index.ts"
const tools = withAssembly(
  {
    get_stock_price: { execute: async (args) => runMastraTool(getStockPriceTool, args) },
    place_trade: { execute: async (args) => runMastraTool(placeTradeTool, args) },
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "mastra-example-agent" }
);

const price = await tools.get_stock_price.execute({ ticker: "AASM" });
console.log(`  [ALLOW] ${JSON.stringify(price)}`);

try {
  await tools.place_trade.execute({ ticker: "AASM", shares: 100 });
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log(`  [BLOCKED] ${err.message}`);
  }
}
```

## Notes & caveats

:::note Uses the real `@mastra/core` package
This example installs `@mastra/core` and `zod`. It still runs offline because the
tools return mock output — no provider key or live LLM is involved.
:::

:::tip withAssembly instead of a framework hook
The published `@agent-assembly/sdk` alpha exposes governance through the public
`withAssembly(tools, { gatewayClient })` API, so the example governs each Mastra tool's
`execute` directly rather than using a framework-specific hook.
:::

## Expected behavior

```text
=== Mastra — Agent Assembly Governance Example ===

Tools defined with Mastra's createTool, governed by withAssembly.

Running allowed tool: get_stock_price
  [ALLOW] {"text":"AASM: $123.45 [mock]"}

Running denied tool: place_trade
  [BLOCKED] Tool 'place_trade' blocked: Placing trades moves real money — requires human approval.

Done. Mastra tool calls governed by withAssembly + the local policy.
```

## Links

- Example directory: [`node/mastra`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/mastra)
- Example README: [`README.md`](https://github.com/ai-agent-assembly/agent-assembly-examples/blob/master/node/mastra/README.md)
- [Mastra](https://mastra.ai)
