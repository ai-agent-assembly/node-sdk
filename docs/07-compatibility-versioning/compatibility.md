---
sidebar_position: 1
---

# Compatibility

## Node.js

The SDK targets active Node.js LTS lines. The napi-rs ABI used by the native binding
requires **Node.js ≥ 18.18.0**; older lines (≤ 16) are unsupported.

| Node.js | Linux | macOS | Windows |
| ------- | ----- | ----- | ------- |
| 18      | ✅    | ✅    | ✅      |
| 20      | ✅    | ✅    | ✅      |
| 22      | ✅    | ✅    | ✅      |
| 24      | ✅    | ✅    | ✅      |

This matrix is enforced by `.github/workflows/test-matrix.yml`, which runs the full grid on
pushes to `master` and on release tags, and an ubuntu-only subset on pull requests for fast
feedback.

### Prebuilt native packages

Prebuilt platform runtime packages (`@agent-assembly/runtime-*`) are published for
**linux-x64, linux-arm64, darwin-x64, and darwin-arm64**. There is no prebuilt package for
Windows: Windows hosts are tested in CI but build the native addon from source, which
requires a Rust toolchain. See [Troubleshooting](../08-troubleshooting/index.md).

## Frameworks

`initAssembly()` auto-detects and governs the agent frameworks below. Each is an
**optional** peer dependency — the SDK works without any of them installed, and only
hooks into the ones it finds at runtime. The version floors are the major lines the
governance hooks are built against and verified in the cross-repo live smokes; newer
releases on the same major line are expected to work. These ranges mirror the
`peerDependencies` declared in `package.json`.

| Framework     | Peer dependency        | Supported range |
| ------------- | ---------------------- | --------------- |
| LangChain.js  | `@langchain/core`      | `>=0.3.0`       |
| LangGraph.js  | `@langchain/langgraph` | `>=1.0.0`       |
| Vercel AI SDK | `ai`                   | `>=5.0.0`       |
| Mastra        | `@mastra/core`         | `>=0.20.0`      |
| OpenAI Agents | `@openai/agents`       | `>=0.1.0`       |

:::note[Vercel AI SDK: govern tools with `withAssembly()`]
The Vercel AI SDK adapter is **usable** with real `ai` 5.x/6.x releases. A real `ai` ES
module is a frozen namespace, so `initAssembly()` cannot auto-patch its `tool` export —
rather than crashing (the earlier
[AAASM-3532](https://lightning-dust-mite.atlassian.net/browse/AAASM-3532) behavior), the
SDK now logs a one-time warning and declines auto-patching, leaving zero-config init
intact. Govern Vercel AI SDK tools explicitly by wrapping the tool map with
`withAssembly()` — see the [Vercel AI SDK example](../09-examples/vercel-ai.md).
:::

This page is the **authoritative** reference for the Node SDK's framework support. The
product-wide, cross-SDK **index/hub** that points at each language SDK's matrix lives in
the core documentation:
[Framework compatibility](https://docs.agent-assembly.com/core/stable/reference/framework-compatibility.html)
(the `/stable/` link goes live at GA).

## Package manager

`pnpm ≥ 10` is the supported package manager (enforced via `engines` and a committed
`pnpm-lock.yaml`). `npm` and `yarn` can install the published package as a dependency, but
contributing to this repository requires pnpm.

## Module systems

The package ships both ESM and CJS entries with conditional `exports`. `import` resolves to
`dist/esm/`, `require` resolves to `dist/cjs/`, and TypeScript consumers in either module
system resolve `dist/types/index.d.ts`. See [Architecture](../03-core-concepts/architecture.md) for how the
dual build is produced.

## Core runtime

`@agent-assembly/sdk` is a client of the Agent Assembly core runtime
([agent-assembly](https://github.com/ai-agent-assembly/agent-assembly)) and speaks the
shared wire protocol to the gateway. The release process keeps the two aligned: each SDK
release bumps the main package **and** the four `@agent-assembly/runtime-*` packages to the
same version, and the `aasm` runtime binaries inside those packages are taken from the
**matching** `agent-assembly` release tag (see [Release process](./releasing.md)).

Practical guidance:

- Install the SDK version whose runtime packages match the gateway you run. The simplest
  path is to let the SDK auto-start its bundled local `aasm` runtime, which is already
  version-matched.
- Because the project is **pre-1.0**, the wire protocol may change between minor versions.
  Pin an exact SDK version and upgrade the SDK and any standalone gateway together.

The cross-repo **core ↔ SDK compatibility matrix** — which SDK versions pair with which
core runtime releases across all language SDKs — is published on the
[Agent Assembly documentation hub](https://docs.agent-assembly.com/).
Consult it when running a standalone gateway you upgrade independently of the SDK.
