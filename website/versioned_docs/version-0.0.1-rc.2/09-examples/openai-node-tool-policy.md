---
sidebar_position: 4
---

# OpenAI Node tool policy

Source: [`node/openai-node-tool-policy`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/openai-node-tool-policy)

## What this example demonstrates

An OpenAI Node SDK-style example that enforces tool policies on tools declared in
**OpenAI function-calling format**. It governs tool dispatch with `withAssembly()`
and a custom `GatewayClient` enforcing a local policy:

- `search_web` is **allowed** — it executes and returns mock results.
- `send_email` is **denied** — it is blocked at the policy layer before execution.

The governance point: tools defined in the OpenAI function-calling schema can be
dispatched through `withAssembly`, so every dispatch is policy-checked before it runs.

## The framework / library

OpenAI function-calling format (tool schemas), used without a live OpenAI client.
The example depends only on `@agent-assembly/sdk` (version `0.0.1-rc.2`) and runs
fully offline — no gateway and no `@langchain/core`.

## How it works

`src/tools.ts` declares two tools in OpenAI `type: "function"` format
(`TOOL_DEFINITIONS`) plus their mock implementations. `src/policy.ts` defines the
allow/deny rules and the in-process `GatewayClient`. `src/index.ts` passes both to
`withAssembly`. When the simulated `send_email` tool call is dispatched, the policy
check denies it and `withAssembly` throws `PolicyViolationError` before `sendEmail`
runs.

## Prerequisites & running it

See [Preparing the runtime environment](./setup.md) for the shared prerequisites.
Then:

```bash
cd node/openai-node-tool-policy
pnpm install
pnpm start
```

All tests run offline — no gateway or API key required. For **real-provider mode**,
copy `.env.example` to `.env` and set `AAASM_GATEWAY_URL` and optionally
`OPENAI_API_KEY`:

```bash
cp .env.example .env
# Set AAASM_GATEWAY_URL and optionally OPENAI_API_KEY
```

## Code walkthrough

Tools are declared in OpenAI function-calling format:

```ts title="src/tools.ts"
export const TOOL_DEFINITIONS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for information.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] },
    },
  },
  // ... send_email ...
];
```

The policy allows `search_web` and denies `send_email`:

```ts title="src/policy.ts"
export const POLICY_RULES: PolicyRule[] = [
  { tool: "search_web", action: "allow", reason: "Read-only search — safe to execute without approval." },
  { tool: "send_email", action: "deny", reason: "External communication requires human approval before sending." },
];
```

`index.ts` dispatches each governed tool and catches the denied one:

```ts title="src/index.ts"
const tools = withAssembly(
  {
    search_web: { execute: async (args) => searchWeb(String(args.query ?? "")).output },
    send_email: { execute: async (args) => sendEmail(String(args.to ?? ""), String(args.subject ?? "")).output },
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "openai-node-example-agent" }
);

try {
  await tools.send_email.execute({ to: "user@example.com", subject: "Hello from agent" });
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log(`  [BLOCKED] ${err.message}`);
  }
}
```

## Notes & caveats

:::note Offline by default
All tests run offline — no gateway or API key required.
:::

:::caution Gateway connection refused
If real-provider mode fails to connect, remove `AAASM_GATEWAY_URL` from `.env` to fall
back to offline mode.
:::

## Expected behavior

```text
=== OpenAI Node SDK-style Agent Assembly Example ===

Available tools: search_web, send_email

Simulating OpenAI tool call: search_web
  [ALLOW] Search results for "Agent Assembly governance": [mock result 1] [mock result 2]

Simulating OpenAI tool call: send_email (should be denied)
  [BLOCKED] Tool 'send_email' blocked: External communication requires human approval before sending.

Tool calls governed by withAssembly + the local policy.
```

## Links

- Example directory: [`node/openai-node-tool-policy`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/openai-node-tool-policy)
- Example README: [`README.md`](https://github.com/ai-agent-assembly/agent-assembly-examples/blob/master/node/openai-node-tool-policy/README.md)
