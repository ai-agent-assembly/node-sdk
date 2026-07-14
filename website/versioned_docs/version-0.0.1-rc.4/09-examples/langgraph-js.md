---
sidebar_position: 7
---

# LangGraph.js

Source: [`node/langgraph-js`](https://github.com/ai-agent-assembly/examples/tree/master/node/langgraph-js)

## What this example demonstrates

Governing the tool calls inside a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)-style
**state machine** with Agent Assembly. A minimal `StateGraph` (typed state, named
nodes, edges) runs two nodes, each calling a governed tool:

- The `search` node calls `search_docs` — **allowed**.
- The `escalate` node calls `execute_shell` — **denied**, blocked with `PolicyViolationError`.

The governance point: governance applies per tool call regardless of where the call
originates — including from inside a graph node.

## The framework / library

A hand-rolled [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)-style graph.
The example depends only on `@agent-assembly/sdk` (version `0.0.1-rc.4`).

:::note[Why a hand-rolled graph instead of `@langchain/langgraph`]
The real `@langchain/langgraph` package transitively installs `@langchain/core`. These
non-LangChain examples deliberately avoid that dependency so they run offline in CI
with no API keys. `src/graph.ts` replays the LangGraph.js shape — a typed state,
`addNode`/`addEdge`/`setEntryPoint`/`compile`/`invoke` — so the example reads like a
LangGraph.js graph while staying dependency-free. The governance path is identical to
a real graph: each node calls a tool wrapped by `withAssembly`.
:::

## How it works

`src/graph.ts` implements a small `StateGraph`/`CompiledGraph` that walks nodes along
edges from an entry point. `src/index.ts` builds the governed tools once with
`withAssembly`, then defines two nodes that call them. `invoke()` runs `search`
(allowed) then `escalate`; the `escalate` node's `execute_shell` call is denied, so
`withAssembly` throws `PolicyViolationError`, which the node catches and logs.

## Prerequisites & running it

See [Preparing the runtime environment](./setup.md) for the shared prerequisites.
Then:

```bash
cd node/langgraph-js
pnpm install
pnpm start
```

No gateway or API key required — all tests run offline. To connect to a real gateway,
set `AAASM_GATEWAY_URL` in your environment directly.

## Code walkthrough

The policy allows the knowledge-base search and denies shell execution:

```ts title="src/policy.ts"
export const POLICY_RULES: PolicyRule[] = [
  { tool: "search_docs", action: "allow", reason: "Read-only knowledge-base search — safe to execute." },
  { tool: "execute_shell", action: "deny", reason: "Arbitrary shell execution is never allowed from a graph node." },
];
```

Governed tools are built once, then called from inside the graph nodes:

```ts title="src/index.ts"
const tools = buildGovernedTools(); // withAssembly(...)

const graph = new StateGraph<GraphState>()
  .addNode("search", async (state) => {
    const out = await tools.search_docs.execute({ query: state.query });
    console.log(`  [ALLOW] ${out}`);
    return { ...state, log: [...state.log, String(out)] };
  })
  .addNode("escalate", async (state) => {
    try {
      await tools.execute_shell.execute({ command: "rm -rf /" });
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        console.log(`  [BLOCKED] ${err.message}`);
        return { ...state, log: [...state.log, `BLOCKED: ${err.message}`] };
      }
      throw err;
    }
    return state;
  })
  .setEntryPoint("search")
  .addEdge("search", "escalate")
  .addEdge("escalate", END)
  .compile();
```

## Notes & caveats

:::note[Offline by design]
The example uses only mock/offline mode. No provider key, no live LLM, and no
`@langchain/core` are required.
:::

:::tip[Governance is location-independent]
The denied `execute_shell` call is blocked the same way whether it is invoked
top-level or from inside a graph node — `withAssembly` enforces the policy at the call
site.
:::

## Expected behavior

```text
=== LangGraph.js-style Graph — Agent Assembly Governance Example ===

A two-node state machine whose tool calls are governed by withAssembly.

Node "search" — calling allowed tool: search_docs
  [ALLOW] Top result for "How does Agent Assembly work?": Agent Assembly governs every tool call. [mock]

Node "escalate" — calling denied tool: execute_shell
  [BLOCKED] Tool 'execute_shell' blocked: Arbitrary shell execution is never allowed from a graph node.

Graph finished with 2 logged steps.
Done. Graph-node tool calls governed by withAssembly + the local policy.
```

## Links

- Example directory: [`node/langgraph-js`](https://github.com/ai-agent-assembly/examples/tree/master/node/langgraph-js)
- Example README: [`README.md`](https://github.com/ai-agent-assembly/examples/blob/master/node/langgraph-js/README.md)
- [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)
