---
slug: /
sidebar_position: 1
---

# Introduction

**In plain terms:** AI agents take actions on their own — searching the web, calling
APIs, reading files. This SDK puts a checkpoint in front of those actions, so a tool you
wrap is decided by a policy client before its body runs. How much that checkpoint is
worth depends on how you configure it: the client the SDK falls back to allows
everything and keeps no record, which the two sections below spell out. You add it to an
agent built in Node.js with a few lines of code; you don't have to rewrite the agent.

**`@agent-assembly/sdk`** is the TypeScript and Node.js SDK for
[Agent Assembly](https://github.com/ai-agent-assembly). It lets you put a
governance layer in front of the AI agents you build in Node — so a tool you wrap
reaches the gateway client you configure for a decision *before* its body runs, and
governance-relevant actions are emitted as audit events.

What that buys depends on the client. Tools decided by a client that can answer
authoritatively are **denied before execution** when it denies them. Pass explicit
`langchain.tools` without such a client and `initAssembly` refuses to start, rather
than route their checks through the allow-all no-op client. For a framework it
auto-detects instead, there is no such refusal — it warns and proceeds, so that
installing a dependency does not break a zero-config startup.

Where those events go depends on which gateway client you use. The native client
hands hook-layer audit events to the runtime over the same channel agent registration
uses. The no-op client — the one `auto` / `sdk-only` / `grpc-sidecar` resolve, so the
default one — holds no channel and drops them, and on that path governed actions
produce no audit trail at all.

**Neither is an audit guarantee.** The handoff is fire-and-forget and unacknowledged,
so this SDK cannot tell you the event arrived, and does not claim it did. Treat
`"forwarded"` as "handed to the runtime", not as evidence you can cite.
`initAssembly` warns when the events are being dropped and reports `auditSink` on the
returned context: `"forwarded"`, `"discarded"`, or `"caller-supplied"` (AAASM-5750).

The audit disposition does not change the enforcement posture either way — but do not read
that as "enforcement still applies". Whether a policy DENY can block a tool depends on
the mode: only a check-capable run (`napi-inprocess`, or your own `gatewayClient`)
gets an authoritative `check()`. In `auto` / `sdk-only` / `grpc-sidecar` the check is
the allow-all no-op stub, so the call is not even *Evaluated*.

In practice the SDK is two things working together:

- **A TypeScript client.** A small, framework-friendly API — most of the time you
  call one function, `initAssembly(...)`, and the SDK wires governance into the agent
  framework you already use (LangChain, and experimentally a few others).
- **An in-process governance shim.** A native binding (compiled from Rust with
  napi-rs) that connects to the Agent Assembly **gateway** — the service that holds
  your policies and renders allow / deny / approval decisions. The SDK can even
  auto-start a local gateway for you so there is nothing to stand up by hand.

You write your agent the way you normally would. The SDK wraps the tools you hand it
so the gateway client you configured decides the call first: if it **allows**, the
tool runs; if it **denies**, the call throws instead of executing; if it needs a
human, the call waits for an approval decision.

## Who this is for

- Developers building agents in Node/TypeScript who want governance wired in without
  rewriting their agent code. What this SDK layer gives you by default is narrower than
  the three things people usually come for, so all three are worth stating:
  - **Allow/deny enforcement** — only in a check-capable run. `napi-inprocess`, or your
    own `gatewayClient`, routes checks to the runtime; `auto` / `sdk-only` /
    `grpc-sidecar` route through the allow-all no-op client, where a DENY does not block.
  - **Redaction** — applied by the runtime/proxy, not here. Under `enforce` this layer
    treats a `redact` verdict as allow (see [Configuration](../05-configuration/index.md)).
  - **An audit trail** — not on the default path: the no-op client `auto` resolves
    holds no event channel and drops hook-layer audit events. `napi-inprocess` hands
    them to the runtime instead, which is a handoff and not a retention guarantee
    (AAASM-5750).
- Teams adopting Agent Assembly who want the fastest, in-process interception path —
  the SDK layer — rather than (or in addition to) the sidecar proxy and eBPF layers.

If you just want to get something running, jump to the
**[Quick Start](../02-quick-start/index.md)**. If you want to understand how the pieces
fit, read **[Core Concepts](../03-core-concepts/index.md)**.

## How the docs are organized

| Section | What it covers |
| --- | --- |
| **[Quick Start](../02-quick-start/index.md)** | Install, configure, and govern your first agent — copy-paste. |
| **[Core Concepts](../03-core-concepts/index.md)** | The native FFI, the adapter registry, the `initAssembly` lifecycle, dual ESM/CJS, modes. |
| **[Guides](../04-guides/index.md)** | Real scenarios: LangChain, low-level `withAssembly`, experimental frameworks, handling decisions & errors. |
| **[Configuration](../05-configuration/index.md)** | Gateway URL / API-key resolution, every `AssemblyConfig` field, modes and enforcement. |
| **[API Reference](../06-api-reference/index.md)** | The full TypeScript surface, auto-generated from the source. |
| **[Compatibility & Versioning](../07-compatibility-versioning/compatibility.md)** | Node LTS matrix, supported platforms, core↔SDK alignment, releasing. |
| **[Troubleshooting](../08-troubleshooting/index.md)** | Gateway auto-start, the native addon, configuration failure modes. |

## Beyond this SDK

- [agent-assembly](https://github.com/ai-agent-assembly/agent-assembly) — the core Rust
  runtime and the home of the protocol specification. Its
  [documentation site](https://docs.agent-assembly.com/core/) is the best
  place to understand the gateway, the policy engine, and the three interception layers
  this SDK plugs into.
- [Canonical documentation hub](https://docs.agent-assembly.com/)
  — cross-repo platform documentation and the core↔SDK compatibility matrix.
- [Organization profile](https://github.com/ai-agent-assembly) — every Agent Assembly
  repository and its status.
