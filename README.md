# @agent-assembly/sdk

[![npm version](https://img.shields.io/npm/v/@agent-assembly/sdk.svg)](https://www.npmjs.com/package/@agent-assembly/sdk)
[![CI](https://github.com/ai-agent-assembly/node-sdk/actions/workflows/test-matrix.yml/badge.svg?branch=master)](https://github.com/ai-agent-assembly/node-sdk/actions/workflows/test-matrix.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=ai-agent-assembly_node-sdk&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ai-agent-assembly_node-sdk)
[![codecov](https://codecov.io/gh/ai-agent-assembly/node-sdk/branch/master/graph/badge.svg)](https://codecov.io/gh/ai-agent-assembly/node-sdk)

TypeScript/Node.js SDK for Agent Assembly, licensed under Apache 2.0.

## Project status

> **Pre-1.0 / alpha.** The current release line is `0.0.1-alpha.x`, published to npm under
> the `alpha` dist-tag. The public surface (`initAssembly`, `withAssembly`) is stabilizing
> but **may change between alpha releases**, and per-platform native packaging is still
> being hardened. Pin an exact version for reproducible installs and review the
> [release notes](https://github.com/ai-agent-assembly/node-sdk/releases) before upgrading.
> Production deployments should track the first `0.1.0` release.

```bash
pnpm add @agent-assembly/sdk@alpha   # latest alpha
pnpm add @agent-assembly/sdk@0.0.1-alpha.3   # pin exact
```

## Prerequisites

Before installing or contributing, ensure your environment has:

- **Node.js** ≥ 18.18.0 (LTS). The active LTS lines (18, 20, 22, 24) are exercised in CI.
- **pnpm** ≥ 10. The repository enforces pnpm via `engines` and ships a `pnpm-lock.yaml`.
- **Rust toolchain** (only required when rebuilding the native `aa-ffi-node` binding from
  source — most consumers receive a prebuilt platform binary via `optionalDependencies`).

## Installation

```bash
pnpm add @agent-assembly/sdk
# or
npm install @agent-assembly/sdk
# or
yarn add @agent-assembly/sdk
```

The SDK ships dual ESM/CJS entries and selects a prebuilt native binding for your platform
during `postinstall`. No additional build step is required for typical consumers.

## Quickstart

Pass your LangChain-style tools (`{ name, invoke }`) to `initAssembly` under
`langchain.tools`. Each tool is wrapped **in place** so every `invoke()` is checked
against gateway policy before it runs.

### ESM (`import`)

```ts
import { initAssembly } from "@agent-assembly/sdk";

const searchWeb = {
  name: "search_web",
  invoke: async (input: { q: string }) => `results for ${input.q}`
};

const ctx = await initAssembly({
  gatewayUrl: "http://localhost:7391",
  agentId: "demo",
  langchain: { tools: { searchWeb } }
});

await searchWeb.invoke({ q: "agent assembly" }); // governed; throws on policy deny
await ctx.shutdown();
```

### CJS (`require`)

```js
const { initAssembly } = require("@agent-assembly/sdk");

const searchWeb = {
  name: "search_web",
  invoke: async (input) => `results for ${input.q}`
};

const ctx = await initAssembly({
  gatewayUrl: "http://localhost:7391",
  agentId: "demo",
  langchain: { tools: { searchWeb } }
});

await searchWeb.invoke({ q: "agent assembly" });
await ctx.shutdown();
```

Both entrypoints resolve to the same governance pipeline; the package's `exports` field
selects ESM or CJS automatically based on how the consumer imports it.

`initAssembly()` registers the LangChain callback handler and auto-wraps the configured
tools, so each is checked against gateway policy before invocation. For more frameworks
and the lower-level `withAssembly()` wrapper, see the **Examples** guide on the
[documentation site](https://ai-agent-assembly.github.io/node-sdk/).

## Supported Node.js versions

The SDK is tested against every active Node.js LTS line on every supported operating
system. The matrix is enforced by `.github/workflows/test-matrix.yml`:

| Node.js | Linux (ubuntu-latest) | macOS (macos-latest) | Windows (windows-latest) |
| ------- | --------------------- | -------------------- | ------------------------ |
| 18      | ✅                    | ✅                   | ✅                       |
| 20      | ✅                    | ✅                   | ✅                       |
| 22      | ✅                    | ✅                   | ✅                       |
| 24      | ✅                    | ✅                   | ✅                       |

Older Node.js lines (≤ 16) are unsupported because the napi-rs ABI used by the native
binding requires Node 18.18 or newer.

## How it works

The SDK is a thin TypeScript wrapper around the Agent Assembly Rust runtime. It reaches
the runtime over one of two transports:

- a **gRPC sidecar** client that talks to a separate gateway process, or
- a **native in-process** binding built with napi-rs.

`initAssembly()` is the primary entrypoint. It resolves the gateway, registers the agent,
and installs governance hooks for whichever supported framework it detects, so every tool
call is checked against policy before it runs.

## What the package exports

| Export | Purpose |
| ------ | ------- |
| `initAssembly(config)` | Set up governance and auto-wire detected frameworks. The main entrypoint. |
| `withAssembly(tools, options)` | Lower-level wrapper to govern a tool map when you manage the gateway client yourself. |
| `currentAgentId()`, `runWithAgentId()` | Read and set the active agent id in the async-context lineage store. |
| `encodeAuditEvent()` / `decodeAuditEvent()` (and the call-stack codecs) | Encode and decode audit events to and from their wire shape. |
| `findAasmBinary()`, `INSTALL_HINT` | Locate the bundled `aasm` runtime binary and the install hint shown when it is missing. |
| `ENFORCEMENT_MODES` | The allowed `enforcementMode` values. |

Type-only exports (`AssemblyConfig`, `AssemblyContext`, `AssemblyMode`, `EnforcementMode`,
`ToolMap`, and friends) are documented in the
[API reference](https://ai-agent-assembly.github.io/node-sdk/api-reference).

## How LangChain tools are blocked

LangChain's `handleToolStart` callback cannot stop a tool from running by its return
value, so the SDK governs LangChain tools with two cooperating layers:

- **Callback layer** (`AssemblyCallbackHandler`) — tracks deferred denials and redacts
  output at `handleToolEnd`.
- **Wrapper layer** (`wrapToolWithAssembly`) — enforces the real pre-execution
  allow / deny / pending check.

`initAssembly()` registers the callback handler and wraps your configured LangChain tools
for you, so you do not wire either layer by hand.

## Matching policies to tools

Most frameworks expose a tool `name` that policies match on. **Vercel AI SDK tools do
not** — they have no `.name` field — so for that framework, write policies that match on
the tool's description content (or, in `withAssembly`, the tool-map key) instead of a
framework-level tool name.

## Source layout

```text
src/
  index.ts                # public entrypoint — re-exports the supported surface
  core/                   # init-assembly flow + gateway/API-key resolution
  adapters/               # Adapter interface + AdapterRegistry, LangChain adapter
  hooks/                  # auto-detection patches (Vercel AI, OpenAI Agents, LangGraph, Mastra)
  gateway/                # gateway client (gRPC sidecar transport)
  native/                 # loader for the napi-rs in-process binding
  wrappers/               # low-level withAssembly() tool wrapper
  lineage/                # async-context store for parent/child agent lineage
  audit/                  # audit-event wire encode/decode helpers
  errors/                 # ConfigurationError, GatewayError, PolicyViolationError, …
  types/                  # AssemblyConfig, AssemblyContext, AssemblyMode, EnforcementMode, …
  proto/generated/        # generated protobuf types
native/aa-ffi-node/       # the Rust napi-rs crate (built into a per-platform .node binary)
tests/                    # unit + architecture tests
```

For how these layers fit together, see the
[Architecture guide](https://ai-agent-assembly.github.io/node-sdk/architecture).

## Building the native binding

Most consumers never build the native binding — a prebuilt binary is installed for their
platform. You only need this when working on the `aa-ffi-node` Rust crate (at
`native/aa-ffi-node`) or running on a platform with no prebuild.

Build commands:

- `pnpm native:build` — debug build, for local development.
- `pnpm native:build:release` — release build that produces the per-platform artifact.
- `pnpm native:check-types` — strict type-check of the generated napi `index.d.ts`.

Run the native integration acceptance test (skipped unless the binding is built):

- `AA_NATIVE_TEST=1 pnpm vitest run tests/native-napi-integration.test.ts`

The `build-addon` GitHub workflow compiles the native addon (Node 20 and 22): an
ubuntu-only debug build on pull requests, and ubuntu + macOS builds on `master` and release
tags. The addon embeds a Unix-domain-socket transport and **does not build on Windows**;
Windows consumers use `grpc-sidecar` mode.

## Packaging layout

The package publishes dual module outputs behind conditional `exports`:

- ESM entry: `./dist/esm/index.js`
- CJS entry: `./dist/cjs/index.js`
- Type declarations: `./dist/types/index.d.ts`

The four `@agent-assembly/runtime-*` packages (`runtime-linux-x64`, `runtime-linux-arm64`,
`runtime-darwin-x64`, `runtime-darwin-arm64`) are declared as `optionalDependencies` and
constrained by `os`/`cpu`, so only the one matching your platform is installed. Each
carries the `aasm` runtime binary; there is no Windows runtime package. The napi-rs `.node`
addon is loaded at runtime by `native/aa-ffi-node/index.cjs`.

CI verifies the published shape with:

- ESM and CJS entry smoke tests,
- an `exports` `types` mapping assertion, and
- `npm pack` content and package-size guard tests.

## Documentation

Full guides, architecture deep-dives, and the complete API reference are published at:

**https://ai-agent-assembly.github.io/node-sdk/**

The site is built from the `docs/` (content) and `website/` (Docusaurus app) directories
and is re-published on every push to `master` via the `publish-docs.yml` workflow.

## Related projects

`@agent-assembly/sdk` is one client of the Agent Assembly platform. The governance
decisions it enforces are made by the core Rust runtime; the protocol it speaks is shared
across all SDKs.

| Project                                                                        | What it is                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [agent-assembly](https://github.com/ai-agent-assembly/agent-assembly)          | Core Rust runtime — gateway, policy engine, proxy, eBPF, CLI (`aasm`). The protocol specification lives here. |
| [Documentation site](https://ai-agent-assembly.github.io/agent-assembly-docs/) | Canonical, cross-repo documentation for the whole platform.                                                   |
| [python-sdk](https://github.com/ai-agent-assembly/python-sdk)                  | Sibling SDK for Python.                                                                                       |
| [go-sdk](https://github.com/ai-agent-assembly/go-sdk)                          | Sibling SDK for Go.                                                                                           |
| [Release notes](https://github.com/ai-agent-assembly/node-sdk/releases)        | Per-version changelog for this package.                                                                       |
| [Organization profile](https://github.com/ai-agent-assembly)                   | Index of every Agent Assembly repository and its status.                                                      |

## Support & security

- **Questions and bug reports** — open an issue on the
  [node-sdk issue tracker](https://github.com/ai-agent-assembly/node-sdk/issues). Include
  your Node.js version, OS/arch, and the SDK version (`pnpm why @agent-assembly/sdk`).
- **Security vulnerabilities** — please do **not** file a public issue. Report privately
  via the repository's
  [security advisories](https://github.com/ai-agent-assembly/node-sdk/security/advisories)
  page so a fix can be coordinated before disclosure.
- **Contributing** — see [CONTRIBUTING.md](./CONTRIBUTING.md) for environment setup, the
  adapter-authoring guide, and the test/commit conventions.
