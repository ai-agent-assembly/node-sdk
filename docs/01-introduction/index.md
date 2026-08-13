---
slug: /
sidebar_position: 1
---

# Introduction

**In plain terms:** AI agents take actions on their own — searching the web, calling
APIs, reading files. This SDK puts a checkpoint in front of those actions so an agent
can only do what your rules allow, and so there's a record of everything it did. You add
it to an agent built in Node.js with a few lines of code; you don't have to rewrite the
agent.

**`@agent-assembly/sdk`** is the TypeScript and Node.js SDK for
[Agent Assembly](https://github.com/ai-agent-assembly). It lets you put a
governance layer in front of the AI agents you build in Node — so every tool an
agent calls is checked against policy *before* it runs, and every governance-relevant
action is emitted as an audit event.

Whether those events are *retained* depends on which gateway client you use. Both
clients this SDK ships discard hook-layer audit events, so on the default path
governed actions produce no audit trail — enforcement still applies, but nothing on
that path can be attributed or reviewed after the fact. Supply your own
`gatewayClient` to retain them; `initAssembly` warns at startup and reports
`auditSink` on the returned context when it knows the events are being dropped
(AAASM-5681).

In practice the SDK is two things working together:

- **A TypeScript client.** A small, framework-friendly API — most of the time you
  call one function, `initAssembly(...)`, and the SDK wires governance into the agent
  framework you already use (LangChain, and experimentally a few others).
- **An in-process governance shim.** A native binding (compiled from Rust with
  napi-rs) that connects to the Agent Assembly **gateway** — the service that holds
  your policies and renders allow / deny / approval decisions. The SDK can even
  auto-start a local gateway for you so there is nothing to stand up by hand.

You write your agent the way you normally would. The SDK wraps each tool so the
gateway sees the call first: if policy **allows** it, the tool runs; if it **denies**
it, the call throws instead of executing; if it needs a human, the call waits for an
approval decision.

## Who this is for

- Developers building agents in Node/TypeScript who need allow/deny enforcement,
  redaction, or an audit trail without rewriting their agent code.
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
