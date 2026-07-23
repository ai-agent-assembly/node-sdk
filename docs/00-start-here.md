---
sidebar_position: 0
sidebar_label: "Start Here: The Golden Path"
---

# Start Here: The Golden Path

**New here? Read this first.** This page is a map, not a manual. It lays out the whole
end-to-end journey of governing a Node/TypeScript agent with `@agent-assembly/sdk`, in
order, and points you at the canonical page that owns each step. Follow the numbered arc
top to bottom; each link takes you to the page where that step actually lives — so the
commands and code stay in one place and never drift out of sync.

The same numbered arc appears in the Python and Go SDK docs, so once you know the shape
here it transfers to the other languages.

## The journey, step by step

### 1. What you'll achieve

By the end you'll have **a governed AI agent whose tool calls you can allow, deny,
observe, and control — without changing the agent's logic.** You keep writing your agent
the way you already do; the SDK wraps each tool so the gateway sees the call *first* and
renders a decision.

### 2. Before you begin

Check the prerequisites and see who this SDK is for before you install anything.
→ [Introduction](./01-introduction/index.md)

### 3. Install

Add `@agent-assembly/sdk` to your project. The install command and supported Node
versions live in the Quick Start.
→ [Quick Start — install](./02-quick-start/index.md)

### 4. Connect to the gateway / runtime

Point the SDK at the gateway that holds your policies (or let it auto-start a local one),
and understand gateway-URL / API-key resolution and the available modes.
→ [Configuration](./05-configuration/index.md)

### 5. Your first governed action (allowed)

Wrap a tool and watch an **allowed** call flow through the gateway and run normally.
→ [Quick Start](./02-quick-start/index.md)

### 6. See a policy denial

Now trigger a **denied** call and see how the wrapped tool throws instead of executing.
This step is about the shape of a denial — what gets thrown and how to respond to it.
→ [Guides — handling allow / deny decisions and errors](./04-guides/index.md#handling-allow--deny-decisions-and-errors)

### 7. Approvals (human-in-the-loop)

Some decisions aren't a flat allow or deny — the gateway can hold a call for a human to
approve. Approvals are rendered by the gateway and surfaced through the same wrapped-call
path as allow/deny; the developer-side handling is covered alongside the decision-handling
guide, and the operator side (who approves, and where) lives on the hub.
→ [Guides — handling decisions](./04-guides/index.md#handling-allow--deny-decisions-and-errors)
· [Documentation hub](https://docs.agent-assembly.com/)

### 8. Observe your agent

Every governance-relevant action is recorded in an audit trail. Viewing the audit trail
and the dashboard is an operator/observability concern that spans all SDKs, so it lives on
the shared hub.
→ [Documentation hub — observability & audit](https://docs.agent-assembly.com/)

### 9. Tune governance

Change a policy and watch the agent's behavior change — the same call that was allowed
now denies, or vice versa. Start from how the SDK resolves and applies configuration, then
reach for the policy reference on the hub.
→ [Configuration](./05-configuration/index.md)
· [Documentation hub — policy reference](https://docs.agent-assembly.com/)

### 10. Operate it

Running and governing the gateway from the operator side — standing it up, managing
policies, and the `aasm` operator tooling — is cross-cutting and shared across the SDKs,
so it lives on the hub.
→ [Documentation hub — operator path](https://docs.agent-assembly.com/)

### 11. Explore framework examples

See the pattern applied end to end in real, runnable Node projects — LangChain.js, Vercel
AI SDK, OpenAI Node, LangGraph.js, Mastra, and a framework-free example.
→ [Examples](./09-examples/index.md)

### 12. You've experienced the core value

You now have a governed agent: its tool calls are checked against policy before they run,
allowed and denied calls behave predictably, held calls wait for a human, and everything
is auditable — all without rewriting the agent. From here: try another framework from the
[Examples](./09-examples/index.md), go deeper on how the pieces fit in
[Core Concepts](./03-core-concepts/index.md), and read the cross-cutting platform docs and
the SaaS/production story on the [Documentation hub](https://docs.agent-assembly.com/).

## Two personas: developer and operator

This page is the **developer arc** — adding governance to an agent from inside your Node
code. There is a second half of the story: the **operator** who runs the gateway, writes
and tunes the policies, approves held calls, and watches the audit trail. That end-to-end
governance walkthrough (developer *and* operator, across all three SDKs) lives on the
shared [Documentation hub](https://docs.agent-assembly.com/). Read this page to build a
governed agent; follow the hub's operator walkthrough to govern it from the other side.
