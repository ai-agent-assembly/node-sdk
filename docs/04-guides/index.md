---
sidebar_position: 1
---

# Guides

Real, end-to-end scenarios. Each section below is self-contained — start with the
LangChain guide if you are new, then reach for the low-level wrapper or the
decision/error guide as you need them.

## Overview

- **[LangChain (validated)](#langchain-validated)** — the supported, test-covered path.
- **[`withAssembly` (low-level)](#withassembly-validated-low-level)** — wrap tools yourself
  with a gateway client you own.
- **[Other frameworks (experimental)](#other-frameworks-experimental-auto-detected)** —
  Vercel AI SDK, OpenAI Agents, LangGraph, Mastra via auto-detection.
- **[Handling allow / deny decisions and errors](#handling-allow--deny-decisions-and-errors)** —
  what the wrapped calls throw and how to respond.

## How `initAssembly` finds your framework

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

:::note[In-process tool enforcement needs a check-capable mode]
For a wrapped tool's **deny** to actually block in-process, the SDK must route each
`check()` through a client that can return an authoritative verdict — that means
`mode: "napi-inprocess"` (or supplying your own `gatewayClient`). In the default
`"auto"` / `"grpc-sidecar"` modes the in-process `check()` is the allow-all no-op, so
under the (default) fail-closed posture `initAssembly` **throws a `ConfigurationError`**
rather than silently letting a denied tool run. Set `enforcementMode: "observe"` /
`"disabled"` if you intend advisory (non-blocking) behavior for wrapped tools.
:::

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
// Only the frameworks whose patch actually took effect, e.g. ["openai-agents"]
// or ["langgraph-js"] or ["mastra"].
//
// A framework can be installed and still be absent here. `ai` (Vercel AI SDK) is
// the common case: it ships as a frozen ES module namespace that the governed
// `tool` factory cannot be written onto, so init warns loudly and reports it as
// ungoverned rather than active (AAASM-4842).
console.log(ctx.detectedAdapters); // e.g. ["vercel-ai-sdk"] — found on disk
console.log(ctx.unpatchedAdapters); // e.g. ["vercel-ai-sdk"] — NOT governed
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

:::note[Auto-detected tool patches also need a check-capable mode]
Like the LangChain wrapper above, the Vercel AI SDK and OpenAI Agents auto-detect patches
gate each tool call on the gateway client's `check()`. But because a bare dependency
install must stay zero-config (auto-detection alone can't tell "installed" apart from
"actually used"), `initAssembly` cannot hard-fail at init the way it does for explicit
`langchain.tools`. In the default `"auto"` / `"grpc-sidecar"` modes without your own
`gatewayClient`, `check()` is the allow-all no-op, so under a fail-closed posture a
patched tool call is **not actually blocked** by a policy deny — `initAssembly` logs a
one-time stderr warning instead of throwing. Use `mode: "napi-inprocess"` (or supply your
own `gatewayClient`) if you need real in-process enforcement for these frameworks.
:::

For the full list of configuration fields used above, see
[Configuration](../05-configuration/index.md).

## Handling allow / deny decisions and errors

When you wrap a tool — whether through `initAssembly`'s `langchain.tools` or directly
with `withAssembly` — the gateway is consulted on every call. The outcome shows up as
ordinary async control flow:

- **Allow.** The wrapped call runs the real tool and returns its result. Nothing extra
  to handle.
- **Deny.** The wrapped call **rejects** with a `PolicyViolationError`. The tool body
  never runs. The error message carries the tool name and the gateway's stated reason.
- **Pending → resolved.** If the gateway needs a human, the call waits up to
  `approvalTimeoutMs` for a decision and then either proceeds (approved) or rejects
  (denied / timed out).

Because these surface as rejected promises, you handle them with a normal
`try`/`catch`:

```ts
import { initAssembly } from "@agent-assembly/sdk";

const ctx = await initAssembly({
  agentId: "demo",
  langchain: {
    tools: { searchWeb },
    approvalTimeoutMs: 30_000 // how long to wait on a "pending" decision
  }
});

try {
  const result = await searchWeb.invoke({ q: "agent assembly" });
  // allowed — use result
} catch (err) {
  // PolicyViolationError on deny, or a timed-out / denied approval.
  // err.message includes the tool name and the gateway's reason.
  console.error("tool call blocked:", (err as Error).message);
}
```

The SDK throws a small set of named error types (defined under `src/errors/`):

| Error | When it is thrown |
| --- | --- |
| `PolicyViolationError` | The gateway denied a tool call, or an approval was denied / timed out. |
| `ConfigurationError` | A configuration problem before any network activity — e.g. zero-config auto-start could not find the `aasm` binary on `PATH`. |
| `GatewayError` | The gateway could not be reached or did not become healthy (e.g. an auto-started gateway failed its health check). |
| `OpTerminatedError` | An in-flight governed operation was terminated. |

In addition, `initAssembly` validates two inputs **before** any network activity and
throws a `RangeError` for bad values: `delegationReason` longer than 256 characters,
or an `enforcementMode` outside `"enforce" | "observe" | "disabled"`. This fail-fast
behavior means a typo can never silently register an agent under the wrong posture.

To run an agent without blocking while you tune policy, register it with
`enforcementMode: "observe"` — every action proceeds and would-be violations are
recorded as shadow audit events instead of throwing. See
[Troubleshooting](../08-troubleshooting/index.md) for the recovery path behind each
error.
