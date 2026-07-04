---
sidebar_position: 1
---

# Quick Start

This page takes you from nothing to a governed agent in a few minutes. Everything
here is copy-paste; the snippets mirror the patterns the SDK's own test suite
exercises.

## 1. Install

```bash
npm install @agent-assembly/sdk
# or: pnpm add @agent-assembly/sdk
# or: yarn add @agent-assembly/sdk
```

The package ships dual ESM/CJS entries and selects a prebuilt native binding for your
platform during `postinstall`, so there is no extra build step for typical consumers.

:::note Pre-1.0 / beta
The current release line is `0.0.1-beta.x`, published under the npm `beta`
dist-tag. The public surface (`initAssembly`, `withAssembly`) is stabilizing but may
change between pre-releases. Pin an exact version for reproducible installs:
`npm install @agent-assembly/sdk@0.0.1-rc.3`.
:::

## 2. Make sure a gateway is reachable

The SDK enforces policy by talking to an Agent Assembly **gateway**. You have two
options:

- **Let the SDK auto-start a local gateway (simplest).** If you have the `aasm`
  binary on your `PATH` (`npm install -g @agent-assembly/cli`), a zero-config
  `initAssembly()` will probe `http://localhost:7391` and start a local gateway for you
  if nothing is running.
- **Point at a gateway you already run.** Set `AAASM_GATEWAY_URL` (and `AAASM_API_KEY`
  if it requires auth), or pass `gatewayUrl` explicitly.

See [Configuration](../05-configuration/index.md) for the full resolution order.

## 3. Govern your first agent with `initAssembly`

`initAssembly()` auto-detects the agent framework you have installed and wires the
right governance hooks. The validated path is **LangChain**: pass your tools under
`langchain.tools` and each one is wrapped *in place*, so every `invoke()` is checked
against gateway policy before it runs.

### ESM (`import`)

```ts
import { initAssembly } from "@agent-assembly/sdk";

// A LangChain-style tool is any object with { name, invoke }.
const searchWeb = {
  name: "search_web",
  invoke: async (input: { q: string }) => `results for ${input.q}`
};

const ctx = await initAssembly({
  agentId: "demo",
  langchain: { tools: { searchWeb } }
});

// Governed: the gateway sees this call first.
// If policy allows, it runs; if it denies, invoke() throws.
await searchWeb.invoke({ q: "agent assembly" });

await ctx.shutdown();
```

### CommonJS (`require`)

```js
const { initAssembly } = require("@agent-assembly/sdk");

const searchWeb = {
  name: "search_web",
  invoke: async (input) => `results for ${input.q}`
};

(async () => {
  const ctx = await initAssembly({
    agentId: "demo",
    langchain: { tools: { searchWeb } }
  });

  await searchWeb.invoke({ q: "agent assembly" });
  await ctx.shutdown();
})();
```

## 4. What to expect

- **Allow.** The tool runs normally and returns its result. A governance event is
  recorded in the audit trail.
- **Deny.** The wrapped `invoke()` *rejects* with a `PolicyViolationError` whose
  message includes the tool name and the gateway's reason — the tool body never runs.
- **Pending (needs approval).** The call waits up to `langchain.approvalTimeoutMs`
  (default applies if unset) for a human decision, then either proceeds or rejects.

That deny-on-policy behavior is the whole point: a denied tool call throws instead of
executing. If you want to watch what *would* be blocked without actually blocking it
while you tune policy, register the agent in observe mode:

```ts
const ctx = await initAssembly({
  agentId: "demo",
  enforcementMode: "observe", // dry-run: actions proceed, violations recorded as shadow events
  langchain: { tools: { searchWeb } }
});
```

## Next steps

- **[Guides](../04-guides/index.md)** — the full LangChain walkthrough, the low-level
  `withAssembly` wrapper, experimental frameworks, and how to handle allow/deny
  decisions and errors.
- **[Configuration](../05-configuration/index.md)** — every `AssemblyConfig` field and
  the gateway/API-key resolution precedence.
- **[Core Concepts](../03-core-concepts/index.md)** — what the native binding, the
  adapter registry, and the `initAssembly` lifecycle actually do.
