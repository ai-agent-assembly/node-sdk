---
sidebar_position: 1
---

# Examples

Runnable, end-to-end Node examples live in the central
[`agent-assembly-examples`](https://github.com/ai-agent-assembly/agent-assembly-examples)
repository, under its [`node/`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node)
directory. Each example is a self-contained project with its own `README` that lists the
exact install and run steps.

Every example uses the same wrapping pattern documented in the
[Guides](../04-guides/index.md): you call `initAssembly()` once to start governance (it
auto-detects your agent framework), and either pass your tools through `initAssembly` or
wrap them explicitly with `withAssembly()` so each tool call is policy-checked before it
runs. The examples differ only in which framework (or none) they integrate with.

## Node examples

| Example | What it demonstrates |
| --- | --- |
| [`custom-tool-policy`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/custom-tool-policy) | Tool-policy governance with no agent framework. |
| [`langchain-js-basic-agent`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/langchain-js-basic-agent) | A governed LangChain.js ReAct agent. |
| [`langgraph-js`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/langgraph-js) | Governance over a LangGraph.js state graph. |
| [`mastra`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/mastra) | Mastra framework integration. |
| [`openai-node-tool-policy`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/openai-node-tool-policy) | OpenAI Node SDK tool-policy enforcement. |
| [`vercel-ai`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/node/vercel-ai) | Vercel AI SDK governance hook. |

For full run steps, follow the `README` inside each example directory.

## Cross-cutting scenarios

Beyond the per-framework examples, the
[`scenarios/`](https://github.com/ai-agent-assembly/agent-assembly-examples/tree/master/scenarios)
directory contains cross-cutting demos that exercise governance end to end.
