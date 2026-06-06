# @agent-assembly/sdk

[![npm version](https://img.shields.io/npm/v/@agent-assembly/sdk.svg)](https://www.npmjs.com/package/@agent-assembly/sdk)
[![CI](https://github.com/AI-agent-assembly/node-sdk/actions/workflows/test-matrix.yml/badge.svg?branch=master)](https://github.com/AI-agent-assembly/node-sdk/actions/workflows/test-matrix.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=AI-agent-assembly_node-sdk&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=AI-agent-assembly_node-sdk)
[![codecov](https://codecov.io/gh/AI-agent-assembly/node-sdk/branch/master/graph/badge.svg)](https://codecov.io/gh/AI-agent-assembly/node-sdk)

TypeScript/Node.js SDK for Agent Assembly, licensed under Apache 2.0.

## Project status

> **Pre-1.0 / alpha.** The current release line is `0.0.1-alpha.x`, published to npm under
> the `alpha` dist-tag. The public surface (`initAssembly`, `withAssembly`) is stabilizing
> but **may change between alpha releases**, and per-platform native packaging is still
> being hardened. Pin an exact version for reproducible installs and review the
> [release notes](https://github.com/AI-agent-assembly/node-sdk/releases) before upgrading.
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

## Goal

Provide a thin wrapper around the Agent Assembly Rust runtime through:

- gRPC sidecar client (default)
- native in-process binding (napi-rs)

The primary entrypoint is `initAssembly()`, which prepares runtime governance and
registers framework hooks for supported tool ecosystems.

## Public Entrypoints

- `initAssembly(config)`
- `withAssembly(tools, options)`

## Policy Matching Constraint

Vercel AI SDK tools do not expose a `.name` field. Governance policies must match
by tool description content (or tool map key in wrapper context), not by strict
framework-level tool name.

## LangChain Blocking Model

LangChain callback `handleToolStart` cannot preempt execution by return value, so
this SDK applies a two-layer model:

- callback layer (`AssemblyCallbackHandler`) tracks deferred denials and redacts at `handleToolEnd`
- wrapper layer (`wrapToolWithAssembly`) enforces true pre-execution deny/pending checks

`initAssembly()` auto-registers the callback handler and auto-wraps configured
LangChain tools.

## Current Architecture Layout

```text
src/
  index.ts
  core/
    init-assembly.ts
  adapters/
    adapter.ts
    adapter-registry.ts
    langchain/
      assembly-callback-handler.ts
      wrap-tool-with-assembly.ts
  gateway/
    client.ts
  wrappers/
    with-assembly.ts
  errors/
    policy-violation-error.ts
  types/
    assembly-mode.ts
    assembly-config.ts
    assembly-context.ts
    gateway-governance.ts
    langchain-adapter.ts
    tool-map.ts
tests/
  architecture/
.github/workflows/
```

## Native napi-rs Binding (AAASM-60)

The `aa-ffi-node` Rust crate is located at `native/aa-ffi-node`.

Build commands:

- `pnpm native:build` (debug/local)
- `pnpm native:build:release` (release + platform artifact)
- `pnpm native:check-types` (strict check for generated napi `.d.ts`)

Native integration acceptance test:

- `AA_NATIVE_TEST=1 pnpm vitest run tests/native-napi-integration.test.ts`

The `build-addon` GitHub workflow compiles the native addon (Node 20 and 22): an
ubuntu-only debug build on pull requests, and ubuntu + macOS builds on `master` and release
tags. The addon embeds a Unix-domain-socket transport and **does not build on Windows**;
Windows consumers use `grpc-sidecar` mode.

## Packaging Layout (AAASM-61)

The package now publishes dual module outputs with explicit conditional exports:

- ESM entry: `./dist/esm/index.js`
- CJS entry: `./dist/cjs/index.js`
- Type declarations: `./dist/types/index.d.ts`

The four `@agent-assembly/runtime-*` packages (`runtime-linux-x64`, `runtime-linux-arm64`,
`runtime-darwin-x64`, `runtime-darwin-arm64`) are declared as `optionalDependencies`,
`os`/`cpu`-constrained so only the matching platform installs. They carry the `aasm`
runtime binary; there is no Windows runtime package. The napi-rs `.node` addon is loaded at
runtime by `native/aa-ffi-node/index.cjs`.

Package verification checks include:

- ESM and CJS entry smoke tests
- export `types` mapping assertion
- `npm pack` content and package size guard tests

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
| [agent-assembly](https://github.com/AI-agent-assembly/agent-assembly)          | Core Rust runtime — gateway, policy engine, proxy, eBPF, CLI (`aasm`). The protocol specification lives here. |
| [Documentation site](https://ai-agent-assembly.github.io/agent-assembly-docs/) | Canonical, cross-repo documentation for the whole platform.                                                   |
| [python-sdk](https://github.com/AI-agent-assembly/python-sdk)                  | Sibling SDK for Python.                                                                                       |
| [go-sdk](https://github.com/AI-agent-assembly/go-sdk)                          | Sibling SDK for Go.                                                                                           |
| [Release notes](https://github.com/AI-agent-assembly/node-sdk/releases)        | Per-version changelog for this package.                                                                       |
| [Organization profile](https://github.com/AI-agent-assembly)                   | Index of every Agent Assembly repository and its status.                                                      |

## Support & security

- **Questions and bug reports** — open an issue on the
  [node-sdk issue tracker](https://github.com/AI-agent-assembly/node-sdk/issues). Include
  your Node.js version, OS/arch, and the SDK version (`pnpm why @agent-assembly/sdk`).
- **Security vulnerabilities** — please do **not** file a public issue. Report privately
  via the repository's
  [security advisories](https://github.com/AI-agent-assembly/node-sdk/security/advisories)
  page so a fix can be coordinated before disclosure.
- **Contributing** — see [CONTRIBUTING.md](./CONTRIBUTING.md) for environment setup, the
  adapter-authoring guide, and the test/commit conventions.
