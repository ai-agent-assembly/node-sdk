---
sidebar_position: 2
---

# Preparing the runtime environment

Every Node example in the
[`examples`](https://github.com/ai-agent-assembly/examples)
repository is a self-contained TypeScript project that shares the same prerequisites
and run commands. This page collects that common setup once so the per-example pages
can focus on what each example actually demonstrates.

## Prerequisites

- **Node.js >= 20 LTS** — install from [nodejs.org](https://nodejs.org).
- **pnpm** — install via `npm install -g pnpm`.

Every example pins `@agent-assembly/sdk` (the [`node-sdk`](https://github.com/ai-agent-assembly/node-sdk)
package, version `0.0.1-rc.5` at the time of writing) as its only required
dependency. The framework-specific examples add one extra package each
(`@mastra/core` for Mastra, `ai` for the Vercel AI SDK).

## Get the examples

Clone the examples monorepo and change into the example you want to run:

```bash
git clone https://github.com/ai-agent-assembly/examples.git
cd examples/node/<example-name>
```

The available `<example-name>` directories are listed on the
[Examples overview](./index.md).

## Common run commands

Each example exposes the same four pnpm scripts:

```bash
pnpm install     # install @agent-assembly/sdk (+ any framework dependency)
pnpm start       # run the example (node --import tsx/esm src/index.ts)
pnpm test        # run the deterministic smoke test (vitest run)
pnpm typecheck   # type-check with tsc --noEmit
```

The shortest path to seeing an example work is three commands:

```bash
cd node/<example-name>
pnpm install
pnpm start
```

## Mock mode vs. real-provider mode

:::tip[Examples run offline by default]
Every Node example runs **fully offline** out of the box. The tools return mock
output and the policy is enforced in-process by a local-policy `GatewayClient`, so
no gateway, no API key, and no live LLM are required. This is what makes the smoke
tests deterministic in CI.
:::

To connect an example to a **real Agent Assembly gateway**, set the gateway
environment variables in your shell. The examples that ship a `.env.example`
(every framework example) document the same variables:

| Variable | Purpose |
| --- | --- |
| `AAASM_GATEWAY_URL` | URL of a running gateway, e.g. `http://localhost:7391`. Omit to use offline/noop mode. |
| `AAASM_API_KEY` | API key — required only when the gateway has auth enabled. |
| `OPENAI_API_KEY` | Provider key — only needed to drive a real LLM. Not used by `custom-tool-policy`. |

For the framework examples, copy the template and edit it:

```bash
cp .env.example .env
# Edit .env: set AAASM_GATEWAY_URL and optionally OPENAI_API_KEY
```

`custom-tool-policy` ships no `.env.example` — it is mock-only. To point it at a
real gateway, set `AAASM_GATEWAY_URL` in your environment directly.

## Starting or reaching a gateway

Real-provider mode talks to an Agent Assembly **gateway**. As described in the
[Quick start](../02-quick-start/index.md), you can either let the SDK auto-start a
local gateway (if the `aasm` binary is on your `PATH`, a zero-config
`initAssembly()` probes `http://localhost:7391` and starts one for you) or point at
a gateway you already run by setting `AAASM_GATEWAY_URL`. The examples themselves
default to offline mode and do not require a gateway to run.
