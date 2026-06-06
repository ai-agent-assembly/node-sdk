---
sidebar_position: 5
---

# Compatibility

## Node.js

The SDK targets active Node.js LTS lines. The napi-rs ABI used by the native binding
requires **Node.js ≥ 18.18.0**; older lines (≤ 16) are unsupported.

| Node.js | Linux | macOS | Windows |
| ------- | ----- | ----- | ------- |
| 18 | ✅ | ✅ | ✅ |
| 20 | ✅ | ✅ | ✅ |
| 22 | ✅ | ✅ | ✅ |
| 24 | ✅ | ✅ | ✅ |

This matrix is enforced by `.github/workflows/test-matrix.yml`, which runs the full grid on
pushes to `master` and on release tags, and an ubuntu-only subset on pull requests for fast
feedback.

### Prebuilt native packages

Prebuilt platform runtime packages (`@agent-assembly/runtime-*`) are published for
**linux-x64, linux-arm64, darwin-x64, and darwin-arm64**. There is no prebuilt package for
Windows: Windows hosts are tested in CI but build the native addon from source, which
requires a Rust toolchain. See [Troubleshooting](./troubleshooting.md).

## Package manager

`pnpm ≥ 10` is the supported package manager (enforced via `engines` and a committed
`pnpm-lock.yaml`). `npm` and `yarn` can install the published package as a dependency, but
contributing to this repository requires pnpm.

## Module systems

The package ships both ESM and CJS entries with conditional `exports`. `import` resolves to
`dist/esm/`, `require` resolves to `dist/cjs/`, and TypeScript consumers in either module
system resolve `dist/types/index.d.ts`. See [Architecture](./architecture.md) for how the
dual build is produced.

## Core runtime

`@agent-assembly/sdk` is a client of the Agent Assembly core runtime
([agent-assembly](https://github.com/AI-agent-assembly/agent-assembly)) and speaks the
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
