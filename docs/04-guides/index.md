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
`langchain.tools`, along with the `gatewayClient` that decides them; tools are wrapped
**in place**, so a call that client denies is **denied before execution** — the wrapper
throws `PolicyViolationError` and the tool body does not run. The callback handler is
registered automatically. Wrapping tools without such a client is refused at startup —
see the note below the snippet.

```ts
import { initAssembly, type GatewayClient } from "@agent-assembly/sdk";

// The wrapper calls this before it runs a wrapped tool body. This one is a local
// allow-list so the snippet runs offline; point `check` at a gateway you run instead.
const policyClient: GatewayClient = {
  mode: "sdk-only",
  start: async () => undefined,
  close: async () => undefined,
  check: async (request) =>
    request.toolName === "search_web"
      ? { denied: false }
      : { denied: true, reason: "not on the allow-list" },
  waitForApproval: async () => ({ denied: false }),
  record: async () => undefined,
  recordResult: async () => undefined,
  scanPrompts: async () => undefined
};

// A LangChain-style tool is any object with { name, invoke }.
const searchWeb = {
  name: "search_web",
  invoke: async (input: { q: string }) => {
    return `results for ${input.q}`;
  }
};

const ctx = await initAssembly({
  gatewayUrl: "http://localhost:7391",
  agentId: "demo",
  gatewayClient: policyClient,
  langchain: {
    tools: { searchWeb },
    approvalTimeoutMs: 30_000 // optional; how long to wait on a "pending" decision
  }
});

// policyClient allows search_web, so this runs and returns. A tool it denies
// would reject with PolicyViolationError instead.
console.log(await searchWeb.invoke({ q: "agent assembly" }));

await ctx.shutdown();
```

When the client returns a **deny**, the wrapped call throws `PolicyViolationError`. When
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

If one of these packages is installed, `initAssembly()` attempts to attach to its
execution surface. Pass `agentId` so lineage is attributed correctly.

**Installing a package is not enough to make it enforcing**, and the amount an
attached adapter buys you differs per framework — read `ctx.activeAdapters` to see
what actually attached, and the table below for what each one then does.

```ts
import { initAssembly } from "@agent-assembly/sdk";

const ctx = await initAssembly({ agentId: "demo" });

console.log(ctx.activeAdapters);
// Only the frameworks whose patch was applied AND is reachable, e.g.
// ["openai-agents"] or ["langgraph-js"] or ["mastra"].
//
// Being listed here does NOT mean a policy DENY will block a call:
//   - langgraph-js / mastra are lineage-tagging only — no tool check runs at all.
//   - langchain-js callbacks are audit-only; only tools wrapped via
//     `langchain.tools` are denied before execution.
//   - every enforcing path still degrades to a non-blocking check unless the run
//     is check-capable (see "Enforcement modes" below).
//
// A framework can also be installed and absent from this list. `ai` (Vercel AI SDK)
// is the common case: it ships as a frozen ES module namespace that the governed
// `tool` factory cannot be written onto, so init warns loudly and reports it as
// unpatched (AAASM-4842). `@langchain/core` installed with no `langchain` config is
// another: there is nothing for the SDK to attach the handler to (AAASM-5664).
console.log(ctx.detectedAdapters); // e.g. ["vercel-ai-sdk"] — found on disk
console.log(ctx.unpatchedAdapters); // e.g. ["vercel-ai-sdk"] — NOT attached at all
```

| Framework     | Detected package       | Status                           | What an applied patch actually does                                                                                      |
| ------------- | ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| LangChain     | `@langchain/core`      | Validated (test suite)           | Tools passed via `langchain.tools` are **denied before execution**.\* Callbacks are audit-only and cannot block — and whether what they record reaches a sink depends on the gateway client.\*\* Requires a `langchain` config; detection alone attaches nothing. |
| OpenAI Agents | `@openai/agents`       | Experimental (auto-detect patch) | Tool calls **denied before execution**.\*                                                                                  |
| Vercel AI SDK | `ai`                   | Experimental (auto-detect patch) | Tool calls **denied before execution**.\* Frozen-ESM installs cannot be patched at all and report as unpatched.            |
| LangGraph     | `@langchain/langgraph` | Experimental (auto-detect patch) | **Lineage tagging only** — binds the agent id around the call so other layers' evidence is attributed to it. Emits no evidence itself and runs no check, so a policy DENY never blocks a call. |
| Mastra        | `@mastra/core`         | Experimental (auto-detect patch) | **Lineage tagging only** — binds the agent id around the call so other layers' evidence is attributed to it. Emits no evidence itself and runs no check, so a policy DENY never blocks a call. |

\* Only in a check-capable run — `mode: "napi-inprocess"` or your own `gatewayClient`.
Otherwise `check()` is the allow-all no-op stub: it produces no control-plane decision
at all, so the call is not "checked and allowed", it is simply uninspected in-process.
See the note below.

\*\* `record` / `recordResult` hand hook-layer audit events to the runtime's event
channel on the `napi-inprocess` client, over a loaded native binding (AAASM-5750). The
handoff is unacknowledged, so it is not an assurance the event was retained, and
[AAASM-5783](https://lightning-dust-mite.atlassian.net/browse/AAASM-5783) is open on
the downstream half. The
default no-op client holds no transport and drops them outright. `auditSink` on the
assembly context reports which case a run is in.

None of this speaks to the proxy or eBPF layers, which are independent of the SDK and
may still see the same activity.

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
with `withAssembly` — the wrapper asks your `gatewayClient` for a decision before it
runs the tool body. The outcome shows up as ordinary async control flow:

- **Allow.** The wrapped call runs the real tool and returns its result. Nothing extra
  to handle.
- **Deny.** The wrapped call **rejects** with a `PolicyViolationError`. The tool body
  never runs. The error message carries the tool name and the reason the client gave.
- **Pending → resolved.** If the decision needs a human, the call waits up to
  `approvalTimeoutMs` for a decision and then either proceeds (approved) or rejects
  (denied / timed out).

Because these surface as rejected promises, you handle them with a normal
`try`/`catch`:

```ts
import { initAssembly } from "@agent-assembly/sdk";

// policyClient and searchWeb are the ones defined in the LangChain section above.
const ctx = await initAssembly({
  gatewayUrl: "http://localhost:7391",
  agentId: "demo",
  gatewayClient: policyClient,
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
