---
sidebar_position: 4
---

# Examples

`initAssembly()` auto-detects which agent framework you have installed and wires the
appropriate governance hooks. The snippets below mirror the patterns exercised by the
SDK's own test suite.

> **Maturity.** The LangChain path and the low-level `withAssembly` wrapper are covered by
> the unit test suite. The Vercel AI SDK, OpenAI Agents, LangGraph, and Mastra
> integrations are wired through auto-detection patches and are **experimental** while the
> SDK is pre-1.0 — treat their ergonomics as subject to change.

## LangChain (validated)

Install `@langchain/core` (a peer dependency). Pass your tools to `initAssembly` under
`langchain.tools`; each tool is wrapped **in place** so every `invoke()` is checked
against gateway policy before it runs. The callback handler is registered automatically.

```ts
import { initAssembly } from "@agent-assembly/sdk";

// A LangChain-style tool is any object with { name, invoke }.
const searchWeb = {
  name: "search_web",
  invoke: async (input: { q: string }) => {
    return `results for ${input.q}`;
  }
};

const ctx = await initAssembly({
  agentId: "demo",
  langchain: {
    tools: { searchWeb },
    approvalTimeoutMs: 30_000 // optional; how long to wait on a "pending" decision
  }
});

// Governed: if policy denies the call, invoke() rejects with a PolicyViolationError.
await searchWeb.invoke({ q: "agent assembly" });

await ctx.shutdown();
```

When the gateway returns a **deny**, the wrapped call throws `PolicyViolationError`. When
it returns **pending**, the call waits up to `approvalTimeoutMs` for a decision and then
either proceeds or throws.

## `withAssembly` (validated, low-level)

`withAssembly` is the explicit, lower-level wrapper for advanced cases where you supply the
gateway client yourself rather than letting `initAssembly` build and own it. It wraps every
tool in a map that exposes an `execute` or `invoke` method, **mutating the objects in
place** and returning the same map. Most applications should prefer `initAssembly`, which
sets up the client and wiring for you.

```ts
import { withAssembly, type WithAssemblyOptions } from "@agent-assembly/sdk";

const tools = {
  search: {
    description: "Search the web",
    execute: async (args: { query: string }) => `result:${args.query}`
  }
};

// `gatewayClient` is required (see WithAssemblyOptions). Provide a client instance —
// for example one constructed in your own bootstrap code, or a test double in unit tests.
const options: WithAssemblyOptions = {
  gatewayClient,
  approvalTimeoutMs: 30_000
};
withAssembly(tools, options);

await tools.search.execute({ query: "hello" }); // now policy-checked
```

## Other frameworks (experimental, auto-detected)

If one of these packages is installed, `initAssembly()` detects it and patches its
execution surface. Pass `agentId` so lineage is attributed correctly.

```ts
import { initAssembly } from "@agent-assembly/sdk";

// With @openai/agents, ai (Vercel AI SDK), @langchain/langgraph, or @mastra/core
// installed, this is all that is required to activate governance for it:
const ctx = await initAssembly({ agentId: "demo" });

console.log(ctx.activeAdapters);
// e.g. ["vercel-ai-sdk"] or ["openai-agents"] or ["langgraph-js"] or ["mastra"]
```

| Framework     | Detected package       | Status                           |
| ------------- | ---------------------- | -------------------------------- |
| LangChain     | `@langchain/core`      | Validated (test suite)           |
| OpenAI Agents | `@openai/agents`       | Experimental (auto-detect patch) |
| Vercel AI SDK | `ai`                   | Experimental (auto-detect patch) |
| LangGraph     | `@langchain/langgraph` | Experimental (auto-detect patch) |
| Mastra        | `@mastra/core`         | Experimental (auto-detect patch) |

> **Tool naming caveat (Vercel AI SDK).** Vercel AI SDK tools do not expose a `.name`
> field, so governance policies must match by tool description content (or the tool-map
> key), not by a framework-level tool name.

For the full list of configuration fields used above, see
[Configuration](./configuration.md).
