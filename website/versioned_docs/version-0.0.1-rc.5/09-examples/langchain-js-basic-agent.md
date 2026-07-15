---
sidebar_position: 5
---

# LangChain.js basic agent

Source: [`node/langchain-js-basic-agent`](https://github.com/ai-agent-assembly/examples/tree/master/node/langchain-js-basic-agent)

## What this example demonstrates

A LangChain.js-style agent that integrates Agent Assembly for tool governance. Every
tool call is routed through a local policy before execution:

- `get_weather` is **allowed** — it executes and logs output.
- `delete_file` is **denied** — it is blocked at the policy layer.

The governance point: wrapping an agent's tools with `withAssembly()` enforces policy
on every tool call the agent makes.

## The framework / library

[LangChain.js](https://js.langchain.com)-style agent. The example depends only on
`@agent-assembly/sdk` (version `0.0.1-rc.5`); it deliberately avoids
`@langchain/core` so it runs fully offline in CI with no API keys.

## How it works

`src/tools.ts` defines a `TOOLS` map of mock tool functions. `src/policy.ts` defines
the allow/deny rules and an in-process `GatewayClient`. `src/index.ts` wraps the tools
with `withAssembly` and runs each one. The `get_weather` call passes the policy check
and runs; the `delete_file` call is denied, so `withAssembly` throws
`PolicyViolationError` before the tool body executes.

## Prerequisites & running it

See [Preparing the runtime environment](./setup.md) for the shared prerequisites.
Then:

```bash
cd node/langchain-js-basic-agent
pnpm install
pnpm start
```

Tests run in offline mode — no gateway or API keys required. For **real-provider
mode**, copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
# Edit .env: set AAASM_GATEWAY_URL and optionally OPENAI_API_KEY
```

Then `pnpm start` connects to the real gateway and real OpenAI API if configured.

## Code walkthrough

The policy allows the read-only lookup and denies the destructive tool:

```ts title="src/policy.ts"
export interface PolicyRule {
  tool: string;
  action: "allow" | "deny";
  reason: string;
}

export const POLICY_RULES: PolicyRule[] = [
  { tool: "get_weather", action: "allow", reason: "Read-only external data lookup — safe to execute." },
  { tool: "delete_file", action: "deny", reason: "Destructive filesystem operations require human approval." },
];
```

`index.ts` wraps the tools and handles the denied call:

```ts title="src/index.ts"
import { PolicyViolationError, withAssembly } from "@agent-assembly/sdk";
import { createPolicyGatewayClient } from "./policy.js";

const tools = withAssembly(
  {
    get_weather: { execute: async (args) => TOOLS.get_weather(args).output },
    delete_file: { execute: async (args) => TOOLS.delete_file(args).output },
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "langchain-js-example-agent" }
);

console.log(`  [ALLOW] ${await tools.get_weather.execute({ location: "Taipei" })}`);

try {
  await tools.delete_file.execute({ path: "/etc/hosts" });
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log(`  [BLOCKED] ${err.message}`);
  }
}
```

## Notes & caveats

:::note[No @langchain/core dependency]
The example uses a LangChain.js-style agent without installing `@langchain/core`, so
it runs offline in CI with no API keys.
:::

:::caution[Gateway connection refused]
If a real gateway is unreachable, omit `AAASM_GATEWAY_URL` to use offline mode.
:::

## Expected behavior

```text
=== LangChain.js-style Agent Assembly Example ===

Running allowed tool: get_weather
  [ALLOW] Weather in Taipei: 22°C, partly cloudy. [mock]

Running denied tool: delete_file
  [BLOCKED] Tool 'delete_file' blocked: Destructive filesystem operations require human approval.

Done. Tool calls governed by withAssembly + the local policy.
```

## Links

- Example directory: [`node/langchain-js-basic-agent`](https://github.com/ai-agent-assembly/examples/tree/master/node/langchain-js-basic-agent)
- Example README: [`README.md`](https://github.com/ai-agent-assembly/examples/blob/master/node/langchain-js-basic-agent/README.md)
- [LangChain.js](https://js.langchain.com)
