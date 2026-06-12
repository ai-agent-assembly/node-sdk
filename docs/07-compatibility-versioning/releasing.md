---
sidebar_position: 7
---

# Release process

Releases are automated by `.github/workflows/release-node.yml`. They are **driven by the
core runtime's release**, not cut independently from this repository — this keeps the SDK
and the `aasm` runtime binaries it ships version-aligned.

## What gets published

Each release publishes **five npm packages at one version**:

- `@agent-assembly/sdk` — the main package.
- `@agent-assembly/runtime-linux-x64`, `runtime-linux-arm64`, `runtime-darwin-x64`,
  `runtime-darwin-arm64` — the `os`/`cpu`-constrained packages carrying the platform
  `aasm` runtime binary.

## Trigger

The workflow runs on either:

- **`repository_dispatch`** (type `agent-assembly-release-published`) — fired by the
  `agent-assembly` release pipeline's `notify-downstream` job once its GitHub Release is
  published. This is the normal path and avoids racing the upstream release.
- **`workflow_dispatch`** — a manual re-run for an already-published tag (e.g. to recover
  from a partial publish), taking the `release_tag` input.

Both paths resolve a `v*.*.*` tag and reject anything that is not SemVer.

## Steps

1. Download the `aasm-<rust-target>.tar.gz` assets from the **matching**
   `ai-agent-assembly/agent-assembly` GitHub Release.
2. Stage each binary into the corresponding `packages/runtime-*/bin/aasm` by Rust target:
   `x86_64-unknown-linux-gnu → runtime-linux-x64`, `aarch64-unknown-linux-gnu →
runtime-linux-arm64`, `x86_64-apple-darwin → runtime-darwin-x64`,
   `aarch64-apple-darwin → runtime-darwin-arm64`.
3. Bump all five `package.json` files (and the `@agent-assembly/runtime-*`
   `optionalDependencies` ranges) to the tag's version.
4. Build the main SDK (`pnpm build`, ESM + CJS).
5. Publish the **four runtime sub-packages first**, then the main SDK — so the main
   package's `optionalDependencies` always resolve to versions that already exist on the
   registry.

## dist-tag

The npm dist-tag is derived from the SemVer pre-release identifier:

- `0.0.1-alpha.3` → published under `--tag alpha`
- `0.0.1-rc.1` → published under `--tag rc`
- `0.0.1` (no pre-release) → published under the default `latest` tag

So pre-1.0 alpha builds never displace `@latest`. Install a specific channel with
`pnpm add @agent-assembly/sdk@alpha`.

## Provenance

Publishing uses npm OIDC Trusted Publishing with `id-token: write` and
`NPM_CONFIG_PROVENANCE=true`, so each release carries SLSA build provenance.

## Documentation publishing

The documentation site is published separately by `.github/workflows/publish-docs.yml` on
pushes to `master` — it is not part of the npm release.
