---
sidebar_position: 3
---

# Custom tool policy

Source: [`node/custom-tool-policy`](https://github.com/ai-agent-assembly/examples/tree/master/node/custom-tool-policy)

## What this example demonstrates

A minimal TypeScript example that uses Agent Assembly governance directly, with **no
agent framework**. It governs two raw TypeScript tools with `withAssembly()` and a
custom `GatewayClient` that enforces a local policy:

- `read_file` is **allowed** — it executes and returns mock file contents.
- `write_file` is **denied** — it is blocked at the policy layer before the tool body runs.

The governance point: you do not need an agent framework to get policy enforcement.
`withAssembly` wraps any object of `{ execute }` tools and checks each call against
the policy first.

## The framework / library

None. The example depends only on `@agent-assembly/sdk` (version `0.0.1-rc.4`
in its `package.json`). It runs fully offline — no gateway and no `@langchain/core`.

## How it works

`src/policy.ts` defines two rules (`read_file` → allow, `write_file` → deny) and
builds an in-process `GatewayClient` whose `check` returns `{ denied: true, reason }`
for denied tools. `src/index.ts` passes that client to `withAssembly` along with the
two tool definitions. When `tools.write_file.execute(...)` is called, `withAssembly`
runs the policy check, sees a deny, and throws a `PolicyViolationError` — the
`write_file` body never runs.

## Prerequisites & running it

See [Preparing the runtime environment](./setup.md) for the shared prerequisites.
Then:

```bash
cd node/custom-tool-policy
pnpm install
pnpm start
```

This example is mock/offline only — no provider keys or gateway URL are needed. To
connect to a real gateway, set `AAASM_GATEWAY_URL` in your environment directly. Run
`pnpm test` for the offline smoke test and `pnpm typecheck` for the type check.

## Code walkthrough

The policy is a simple rule table, evaluated by tool name:

```ts title="src/policy.ts"
export const POLICY_RULES: PolicyRule[] = [
  { tool: "read_file", action: "allow", reason: "Read-only file access is safe to execute." },
  { tool: "write_file", action: "deny", reason: "Write operations to the filesystem require explicit approval." },
];
```

The local-policy `GatewayClient` turns a deny rule into a denied check result:

```ts title="src/policy.ts"
check: async (request) => {
  const rule = evaluate(request.toolName ?? "");
  return rule.action === "deny"
    ? { denied: true, reason: rule.reason }
    : { denied: false };
},
```

`index.ts` wraps the tools and handles the denied call by catching
`PolicyViolationError`:

```ts title="src/index.ts"
const tools = withAssembly(
  {
    read_file: { execute: async (args) => readFile(String(args.path ?? "")).output },
    write_file: { execute: async (args) => writeFile(String(args.path ?? ""), String(args.content ?? "")).output },
  },
  { gatewayClient: createPolicyGatewayClient(), agentId: "custom-tool-policy-agent" }
);

try {
  await tools.write_file.execute({ path: "/etc/config", content: "override settings" });
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log(`  [BLOCKED] ${err.message}`);
  }
}
```

## Notes & caveats

:::note[Offline by design]
The example uses only mock/offline mode. No provider keys or gateway URL are needed,
and all tests run offline.
:::

:::tip[Default-deny]
The policy's `evaluate()` returns a deny rule for any unlisted tool — unknown tools
are denied by default.
:::

## Expected behavior

```text
=== Custom Tool Policy — Minimal TypeScript Example ===

No agent framework required. Using @agent-assembly/sdk directly.

Calling allowed tool: read_file
  [ALLOW] Contents of "/data/report.txt": [mock file contents line 1, line 2]

Calling denied tool: write_file
  [BLOCKED] Tool 'write_file' blocked: Write operations to the filesystem require explicit approval.

All tool calls governed by withAssembly + the local policy.
```

## Links

- Example directory: [`node/custom-tool-policy`](https://github.com/ai-agent-assembly/examples/tree/master/node/custom-tool-policy)
- Example README: [`README.md`](https://github.com/ai-agent-assembly/examples/blob/master/node/custom-tool-policy/README.md)
