---
sidebar_position: 6
---

# Vercel AI SDK

Source: [`node/vercel-ai`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/vercel-ai)

## What this example demonstrates

Governing tools defined with the **Vercel AI SDK `tool()` factory** using Agent
Assembly. Each tool's `execute` is wrapped by `withAssembly()` + a local-policy
`GatewayClient`:

- `get_weather` is **allowed** — it executes and returns mock output.
- `send_email` is **denied** — it is blocked at the policy layer with `PolicyViolationError`.

The governance point: real Vercel AI SDK tools run unchanged; governance is layered on
top by wrapping the tool map.

## The framework / library

[Vercel AI SDK](https://sdk.vercel.ai) — the real `ai` package (version `^6.0.0` in
`package.json`), plus `zod` (`^3.25.76`) for input schemas and `@agent-assembly/sdk`
(version `0.0.1-beta.4`). It runs fully offline — no provider key and no live LLM.

## How it works

`src/tools.ts` defines two tools with the Vercel AI SDK `tool()` factory, each with a
`zod` `inputSchema` and a mock `execute`. `src/index.ts` passes the tool map to
`withAssembly`, which keys the policy by the map key (`get_weather`, `send_email`) and
wraps each tool's `execute`. Calling the governed `send_email` triggers a policy deny,
so `withAssembly` throws `PolicyViolationError` before the underlying tool runs.

Because these are real Vercel AI SDK tools, `execute` takes the SDK's
`(input, { toolCallId, messages })` signature.

## Prerequisites & running it

See [Preparing the runtime environment](./setup.md) for the shared prerequisites.
Then:

```bash
cd node/vercel-ai
pnpm install
pnpm start
```

No gateway or API key required — all tests run offline. To connect to a real gateway,
set `AAASM_GATEWAY_URL` in your environment directly; to drive a real LLM, set
`OPENAI_API_KEY`.

## Code walkthrough

Tools are defined with the Vercel AI SDK `tool()` factory:

```ts title="src/tools.ts"
import { tool } from "ai";
import { z } from "zod";

export const getWeatherTool = tool({
  description: "Look up the current weather for a location.",
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }): Promise<string> =>
    `Weather in ${location}: 22°C, partly cloudy. [mock]`,
});
```

`index.ts` governs the tool map and invokes each tool with the Vercel AI SDK call
signature:

```ts title="src/index.ts"
const tools = withAssembly(
  { get_weather: getWeatherTool, send_email: sendEmailTool },
  { gatewayClient: createPolicyGatewayClient(), agentId: "vercel-ai-example-agent" }
);

const weather = await tools.get_weather.execute?.(
  { location: "Taipei" },
  { toolCallId: "call_weather", messages: [] }
);

try {
  await tools.send_email.execute?.(
    { to: "ops@example.com", body: "exfiltrate everything" },
    { toolCallId: "call_email", messages: [] }
  );
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log(`  [BLOCKED] ${err.message}`);
  }
}
```

## Notes & caveats

:::note Uses the real `ai` package
This example installs the real Vercel AI SDK (`ai`) and `zod`. It still runs offline
because the tools return mock output — no provider key or live LLM is involved.
:::

:::tip withAssembly instead of a framework hook
The published `@agent-assembly/sdk` alpha exposes governance through the public
`withAssembly(tools, { gatewayClient })` API, so the example wraps each tool's
`execute` directly rather than using a framework-specific hook.
:::

## Expected behavior

```text
=== Vercel AI SDK — Agent Assembly Governance Example ===

Tools defined with the Vercel AI SDK `tool()` factory, governed by withAssembly.

Running allowed tool: get_weather
  [ALLOW] Weather in Taipei: 22°C, partly cloudy. [mock]

Running denied tool: send_email
  [BLOCKED] Tool 'send_email' blocked: Outbound messaging can exfiltrate data — requires human approval.

Done. Vercel AI SDK tool calls governed by withAssembly + the local policy.
```

## Links

- Example directory: [`node/vercel-ai`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/vercel-ai)
- Example README: [`README.md`](https://github.com/ai-agent-assembly/agent-assembly-examples/blob/master/node/vercel-ai/README.md)
- [Vercel AI SDK](https://sdk.vercel.ai)
