---
slug: /
sidebar_position: 1
---

# Introduction

Welcome to the developer documentation for **`@agent-assembly/sdk`** — the TypeScript
and Node.js SDK for [Agent Assembly](https://github.com/AI-agent-assembly).

This site is the long-form companion to the GitHub repository
[`AI-agent-assembly/node-sdk`](https://github.com/AI-agent-assembly/node-sdk). The
repository's `README.md` covers installation and a quickstart; this site goes deeper into
architecture, configuration, framework integration, and the auto-generated API reference.

## What's here

- **[Architecture](./architecture.md)** — the napi-rs FFI layer, the framework adapter
  registry, and the dual ESM/CJS package structure.
- **[Configuration](./configuration.md)** — the `initAssembly` init flow, gateway/API-key
  resolution precedence, and every `AssemblyConfig` field.
- **[Examples](./examples.md)** — validated LangChain and `withAssembly` usage, plus the
  experimental auto-detected framework integrations.
- **[Compatibility](./compatibility.md)** — Node LTS matrix, prebuilt platforms, and core
  runtime version alignment.
- **[Troubleshooting](./troubleshooting.md)** — gateway auto-start, native addon, and
  configuration failure modes.
- **[Release process](./releasing.md)** — how the SDK and runtime packages are published.
- **[API reference](./api-reference.md)** — auto-generated from the TypeScript source.

## Beyond this SDK

- [agent-assembly](https://github.com/AI-agent-assembly/agent-assembly) — the core Rust
  runtime and the home of the protocol specification.
- [Canonical documentation site](https://ai-agent-assembly.github.io/agent-assembly-docs/)
  — cross-repo platform documentation.
- [Organization profile](https://github.com/AI-agent-assembly) — every Agent Assembly
  repository and its status.
