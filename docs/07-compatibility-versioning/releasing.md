---
sidebar_position: 2
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
pushes to `main` — it is not part of the npm release.

## Documentation versioning

The docs site uses [Docusaurus versioning](https://docusaurus.io/docs/versioning) to model
three release **channels** on top of the immutable version snapshots:

- **latest (main)** — the in-progress docs in `docs/` (the Docusaurus `current` version).
  Always tracks `main`, is *never* frozen, is served at `/next/` (not the root, so it
  never collides with a real cut version), and carries the native `unreleased` banner.
- **stable** — the newest snapshot cut from a stable tag (`vX.Y.Z`). It is `lastVersion`,
  served at the site root, and is the default landing page. Its dropdown label is
  `stable (vX.Y.Z)` and it shows no banner.
- **pre-release** — the newest snapshot cut from a pre-release tag (`vX.Y.Z-...`). Its
  dropdown label is `pre-release (vX.Y.Z-...)`. When no stable snapshot exists yet, the
  pre-release is the default landing instead.

Older superseded snapshots keep their bare tag as the label and carry the `unmaintained`
banner pointing readers at the stable channel.

### Channel from tag

The release workflow classifies each tag:

- `^v\d+\.\d+\.\d+$` → **stable**
- `^v\d+\.\d+\.\d+-.+` → **pre-release**

### Automated, release-driven cut

Snapshots are cut **automatically by the release workflow**
(`.github/workflows/release-node.yml`), not by hand. After the npm publish succeeds — so a
snapshot is only ever cut on a real, finished release — a `version-docs` job:

1. Runs `pnpm docusaurus docs:version <tag>` from `website/`, freezing today's `docs/`
   into `website/versioned_docs/version-<tag>/` and appending `<tag>` to `versions.json`.
2. Regenerates the per-version `label`s and `banner`s and repoints `lastVersion`
   (newest stable, else newest pre-release) in `website/docusaurus.config.ts`.
3. Commits the generated `versioned_docs/`, `versioned_sidebars/`, `versions.json` and the
   config change, and opens a docs-update PR against `main` (the repo's normal flow).

The `current` version always keeps tracking `main` under the **latest (main)** label.

> Cutting a snapshot manually is not part of the normal flow. If you ever need to recover a
> missed snapshot, run `pnpm docusaurus docs:version <tag>` from `website/` and re-run the
> label/banner/`lastVersion` regeneration the workflow performs.

No `publish-docs.yml` change is needed: `pnpm build` (run by `publish-docs.yml`) builds
every version present in `versions.json` automatically.
