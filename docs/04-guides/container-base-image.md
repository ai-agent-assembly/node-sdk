---
sidebar_position: 2
---

# Governed container base image

Run a containerized Node.js agent that is **governed out of the box**. The
`ghcr.io/ai-agent-assembly/node` images bundle the `aasm` CLI and the
`@agent-assembly/sdk` npm package into a slim Node base layer, so you can build
an agent image with **no extra install step** — `require('@agent-assembly/sdk')`
(or `import`) resolves immediately and `aasm` is already on `PATH`.

## What it is

`ghcr.io/ai-agent-assembly/node:{20,22,24}-slim` is a governed base image for
Node.js agents. Each image is a Debian-slim Node runtime (Node 20, 22, or 24)
with two things preinstalled:

- the **`aasm` CLI** — the Agent Assembly operator binary (`aasm topology`,
  `aasm policy`, `aasm dashboard`, …); and
- the **`@agent-assembly/sdk`** package — globally resolvable, so your agent code
  can `require("@agent-assembly/sdk")` or
  `import { initAssembly } from "@agent-assembly/sdk"` without listing it as a
  dependency.

Because both are baked in, a containerized agent built `FROM` this image is
governed the moment it starts — you do not `npm install` the SDK or fetch the CLI
yourself.

:::note[The SDK layer is not a security boundary on its own]
The in-process SDK layer is the fastest, lowest-latency interception path, but it
relies on SDK adoption and is **not** the authoritative enforcement point. For
real enforcement, pair the image with the `aa-runtime` sidecar (see
[Best practices](#best-practices)).
:::

## Tags — and how to choose

Two families of tags point at the same images. Pick based on whether you need
reproducibility.

| Tag                             | Example                    | Mutability | Use it for                                   |
| ------------------------------- | -------------------------- | ---------- | -------------------------------------------- |
| `node:<runtime>-<core-version>` | `node:24-slim-v0.0.1-rc.1` | Immutable  | **CI and production** — pinned, reproducible |
| `node:<runtime>`                | `node:24-slim`             | Moving     | Local experiments, always-latest core        |
| `node:latest`                   | `node:latest`              | Moving     | Quick tries only — never pin this            |

`<runtime>` is the Node major (`20`, `22`, `24`). `<core-version>` is the **Agent
Assembly core / `aa-runtime` release** baked into the image — which is also the
version of the `aasm` CLI inside it. An immutable tag like
`node:24-slim-v0.0.1-rc.1` always resolves to the exact same bytes, so a rebuild
months later produces an identical governed base.

**Pin the immutable tag** (`node:<runtime>-<core-version>`) anywhere you care
about reproducibility — CI pipelines and production deployments. The bare
`node:<runtime>` and `node:latest` tags move as new core versions ship and are
fine only for throwaway local experiments.

## Quick start

Build an agent image on top of the governed base. There is no SDK install: the
package is already present and `aasm` already works.

```dockerfile
# Pin the immutable tag for a reproducible build.
FROM ghcr.io/ai-agent-assembly/node:24-slim-v0.0.1-rc.1

WORKDIR /app

# Install only YOUR agent's dependencies — the SDK is already in the base image.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The aasm CLI is already on PATH:
#   RUN aasm --version
CMD ["node", "agent.js"]
```

Your `agent.js` uses the SDK with no extra setup:

```js
const { initAssembly } = require("@agent-assembly/sdk");
// or: import { initAssembly } from "@agent-assembly/sdk";

const ctx = await initAssembly({ agentId: "demo" });
// ... run your governed agent ...
await ctx.shutdown();
```

Inside the running container, `aasm --version` reports the core version baked into
the tag, and the SDK resolves from the global install with no entry in your own
`package.json`.

## Choosing the SDK version — the `SDK_VERSION` build-arg

The image builds the bundled SDK from an **optional** `SDK_VERSION` build
argument that controls which `@agent-assembly/sdk` release is baked in:

- **Unset (default).** The build installs the **latest stable** release of the
  SDK. If no stable release exists yet (pre-1.0), it falls back to the **latest
  pre-release**.
- **Set to an exact version.** The build pins that exact release:

  ```bash
  docker build --build-arg SDK_VERSION=0.0.1-beta.5 -t my-agent .
  ```

The **published** `ghcr.io/ai-agent-assembly/node` images are built with
`SDK_VERSION` pinned to a specific release, so each immutable tag carries a known
SDK version. A bare `docker build` of the image without the arg gets the default
(latest stable, else latest pre-release).

## Best practices

- **Pin the immutable tag in CI and production.** Use
  `node:<runtime>-<core-version>` (e.g. `node:24-slim-v0.0.1-rc.1`); **never**
  ship `:latest` to production — it moves under you and breaks reproducibility.
- **Pair with the `aa-runtime` sidecar for enforcement.** The in-process SDK layer
  is the fast path but is not a security boundary by itself. Run the `aa-runtime`
  sidecar alongside the agent so policy is enforced authoritatively even if the
  in-process layer is bypassed.
- **Keep the image core-version and your runtime aligned.** The `<core-version>`
  in the base-image tag should match the `aa-runtime` you deploy, so the bundled
  `aasm` CLI and the enforcing runtime speak the same protocol.
- **Rebuild per release.** When a new core version ships, rebuild your agent image
  against the new immutable tag rather than letting a moving tag drift.

## See also

- **Canonical core guide —**
  [container base images](https://github.com/ai-agent-assembly/agent-assembly/blob/master/docs/src/usage-guide/container-base-images.md)
  (the authoritative reference; the published doc-site page is not live yet).
- **ADR 0009 —**
  [versioned base-image tags and SDK pinning](https://github.com/ai-agent-assembly/agent-assembly/blob/master/docs/src/adr/0009-versioned-base-image-tags-and-sdk-pinning.md).
- [Quick Start](../02-quick-start/index.md) — install the SDK and govern your first agent.
- [Configuration](../05-configuration/index.md) — gateway URL and API-key resolution for the running container.
