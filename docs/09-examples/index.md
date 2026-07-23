---
sidebar_position: 1
---

# Examples

This section walks through the runnable Node examples that ship in the central
[`examples`](https://github.com/ai-agent-assembly/examples)
repository, under its
[`node/`](https://github.com/ai-agent-assembly/examples/tree/HEAD/node)
directory. Each example is a self-contained TypeScript project with its own `README`;
the pages here explain what each one demonstrates, how the governance flow works, and
walk through the real source.

## The shared governance pattern

Every Node example uses the same wrapping pattern documented in the
[Guides](../04-guides/index.md): you wrap your tools with `withAssembly()` so each
tool call is policy-checked **before** it runs. A denied call never executes its tool
body — `withAssembly` throws a `PolicyViolationError` whose message carries the tool
name and the policy's reason.

To keep the examples deterministic and runnable offline in CI, each one supplies a
small in-process `GatewayClient` (`mode: "sdk-only"`) that enforces a local
allow/deny policy without a running gateway. The examples differ only in which
framework (or none) defines the tools that `withAssembly` governs.

Before running any example, see
[Preparing the runtime environment](./setup.md) for the shared prerequisites,
install/run commands, and mock vs. real-provider mode.

## Node examples

| Example | Framework | Page | Source |
| --- | --- | --- | --- |
| `custom-tool-policy` | — (none) | [Custom tool policy](./custom-tool-policy.md) | [dir](https://github.com/ai-agent-assembly/examples/tree/HEAD/node/custom-tool-policy) |
| `openai-node-tool-policy` | OpenAI Node SDK | [OpenAI Node tool policy](./openai-node-tool-policy.md) | [dir](https://github.com/ai-agent-assembly/examples/tree/HEAD/node/openai-node-tool-policy) |
| `langchain-js-basic-agent` | LangChain.js | [LangChain.js basic agent](./langchain-js-basic-agent.md) | [dir](https://github.com/ai-agent-assembly/examples/tree/HEAD/node/langchain-js-basic-agent) |
| `vercel-ai` | Vercel AI SDK | [Vercel AI SDK](./vercel-ai.md) | [dir](https://github.com/ai-agent-assembly/examples/tree/HEAD/node/vercel-ai) |
| `langgraph-js` | LangGraph.js | [LangGraph.js](./langgraph-js.md) | [dir](https://github.com/ai-agent-assembly/examples/tree/HEAD/node/langgraph-js) |
| `mastra` | Mastra | [Mastra](./mastra.md) | [dir](https://github.com/ai-agent-assembly/examples/tree/HEAD/node/mastra) |

For the exact run steps, follow the per-example pages above or the `README` inside
each example directory.

## Cross-cutting scenarios

Beyond the per-framework examples, the
[`scenarios/`](https://github.com/ai-agent-assembly/examples/tree/HEAD/scenarios)
directory contains cross-cutting demos that exercise governance end to end.
