---
name: release-runbook
description: Operate and validate a node-sdk npm release driven by `release-node.yml`. Use when an `agent-assembly` core tag has been (or is about to be) cut and the matching `@agent-assembly/sdk` + 4 runtime sub-packages must reach npm, when verifying that a published release landed correctly across all five packages, or when reasoning about why an SDK-only hotfix is structurally awkward today. This is the coordinated, core-tag-driven release path; for a deliberate SDK-only republish use `/sdk-only-release`.
---

# release-runbook

Operator runbook for the `node-sdk` npm release. The canonical release of
`@agent-assembly/sdk` is **driven by the `agent-assembly` core tag**, not by a
tag cut in this repo: when `agent-assembly`'s `release.yml` finishes, its
`notify-downstream` job fires a `repository_dispatch` (`agent-assembly-release-published`)
that triggers `.github/workflows/release-node.yml` here, which stages the
per-platform `aasm` binaries from that core Release, bumps all five packages,
and publishes them to npm.

This SKILL.md is the lean overview. The sibling `/sdk-only-release` skill covers
the deliberate `workflow_dispatch` SDK-only republish path; this runbook covers
the **coordinated** path plus post-publish validation and the design limitation
that ties the two together.

> This skill ends at "the five packages are live and validated on npm". Cutting
> the upstream `agent-assembly` tag itself is owned by that repo's
> `/release-tag-cut`; the cross-channel matrix (crates.io, PyPI, Homebrew, GHCR)
> is owned by `agent-assembly`'s `/release-validate-channels`.

## When to use

Pick this skill when **any** of the following hold:

- An `agent-assembly` core tag was just cut and you need to confirm the
  downstream node-sdk publish fired, ran, and landed all five npm packages.
- A coordinated release's `release-node.yml` run failed partway and you need to
  re-drive the publish for the same already-pushed core tag.
- You are reasoning about whether a given change can ship as an SDK-only release
  or whether it must wait for a coordinated core-tag release (see the limitation
  section below).

## When NOT to use

- **Cutting the upstream `agent-assembly` tag.** That is the core monorepo's
  `/release-tag-cut`. This repo has no authority to mint the core tag whose
  binaries it bundles.
- **A deliberate SDK-only republish** (TS-only feature, dependency bump, doc
  rebuild between coordinated releases). Use `/sdk-only-release`, which dispatches
  `release-node.yml` with `publish_mode=main-only`. Do not hand-drive the
  coordinated path for that.
- **Bumping only the runtime binaries.** The runtime sub-packages are sourced
  authoritatively from an `agent-assembly` GitHub Release; cut a new core tag.

## The release machinery (what `release-node.yml` actually does)

There are five npm packages in this workspace and they all move together on the
coordinated path:

| Package | Source of its content |
|---|---|
| `@agent-assembly/sdk` (root) | this repo's TS build (`pnpm build`, ESM + CJS) |
| `@agent-assembly/runtime-linux-x64` | `aasm-x86_64-unknown-linux-gnu.tar.gz` |
| `@agent-assembly/runtime-linux-arm64` | `aasm-aarch64-unknown-linux-gnu.tar.gz` |
| `@agent-assembly/runtime-darwin-x64` | `aasm-x86_64-apple-darwin.tar.gz` |
| `@agent-assembly/runtime-darwin-arm64` | `aasm-aarch64-apple-darwin.tar.gz` |

The four `aasm-*.tar.gz` assets are **downloaded from the matching
`agent-assembly` GitHub Release** (`gh release download <binary_source_tag>
--repo ai-agent-assembly/agent-assembly`), unpacked into each runtime package's
`bin/`, and the placeholder `.gitkeep` stripped. The native `aasm` binary is
therefore never built here — it is staged from upstream.

Two trigger surfaces drive the workflow:

- **`repository_dispatch` (`agent-assembly-release-published`)** — the coordinated
  path. `binary_source_tag` and `npm_version` both derive from the **one**
  dispatched core tag (`npm_version = release_tag` with the leading `v` stripped);
  `publish_mode` is hard-coded `all`; `dry_run` is hard-coded `false`. The full
  five-package set always publishes for real.
- **`workflow_dispatch`** — the operator path (`/sdk-only-release` uses this).
  Lets you supply `npm_version`, `binary_source_tag`, `publish_mode`
  (`all` / `main-only`), and `dry-run` independently.

Publish ordering matters: the **four runtime sub-packages publish first**, then
the root SDK, so the SDK's `optionalDependencies['@agent-assembly/runtime-*']`
resolve to versions that already exist on the registry. The npm dist-tag is
derived from the SemVer pre-release identifier (`0.0.1-alpha.N` → `--tag alpha`,
bare `X.Y.Z` → `@latest`). After publish the workflow cuts a matching `v<version>`
git tag + GitHub Release here (idempotent on re-run), and a follow-up
`version-docs` job opens an auto-merged Docusaurus snapshot PR — but only on the
real-publish path.

## ⚠️ Known limitation — one core tag drives three coupled concerns (the WHY)

**This is the load-bearing caveat of this runbook.** On the coordinated
`repository_dispatch` path, `release-node.yml` derives **all three** of the
following from the **single** dispatched `agent-assembly` tag:

1. **`npm_version`** — `release_tag` with the leading `v` stripped.
2. **`binary_source_tag`** — the same tag; the `aasm` binaries are pulled from
   that tag's GitHub Release.
3. **The five-package publish set** — `publish_mode` is hard-coded `all`.

The consequence is that, **on the coordinated path, the npm version a user
installs is structurally pinned to the version of the bundled `aasm` binary.**
There is no coordinated-path mechanism to ship a new `@agent-assembly/sdk`
version that reuses the *existing* runtime binaries — the version number and the
binary source are the same value by construction. So a pure-SDK fix (a bug in
`src/`, a TS-only feature, a dependency bump) cannot ride the coordinated path
without minting a brand-new core tag and republishing all four runtime binaries
it does not actually change.

**Why it is only "awkward", not "impossible" today:** the `workflow_dispatch`
path already partially decouples these axes (`npm_version`, `binary_source_tag`,
and `publish_mode=main-only` are separate inputs — AAASM-2854/2862/2867), and
`/sdk-only-release` documents that operator-driven escape hatch. But it is an
operator-discipline workaround layered on top of a workflow whose **default,
automated** behavior still fuses version + binary + full-fanout to one tag. The
coordinated path has no notion of "SDK only".

**The future fix (decouple, ~50 lines of YAML):** split `release_tag` from
`npm_version` as first-class, independently-resolved values on *both* trigger
surfaces, and make the coordinated path honor a "main SDK only" mode rather than
hard-coding `publish_mode=all` and `npm_version = release_tag`. Concretely:
derive `binary_source_tag` from the dispatched/last-known core tag while letting
`npm_version` advance independently, and gate the runtime-publish stage on an
explicit mode so an SDK-only version can reuse the runtime sub-packages already
on npm. That removes the structural coupling instead of papering over it with the
`workflow_dispatch` + `main-only` workaround. Until that lands, treat every
coordinated release as "version == bundled-binary version", and route every
SDK-only need through `/sdk-only-release`.

## Sync docs version refs + example pins (before publish)

`release-node.yml` rewrites every `package.json` `version` from `npm_version` at
publish time — but it does **not** touch the docs site. The common assumption
that "the docs just say `@beta` so they auto-track" is **wrong here**: the
quick-start and example pages carry **explicit, pinned** version strings that go
stale the moment a new version publishes. Sweep them on the same PR that prepares
the release, *before* the tag is cut.

1. **Bump the checked-in version file** to match the `npm_version` dispatch input
   (the core tag with the leading `v` stripped): set the **root `package.json`**
   `version`. Leave the four runtime sub-package `package.json` files at their
   tree value — `release-node.yml` rewrites all five from `npm_version` at
   publish. Touch `pnpm-lock.yaml` only if it pins the root package's version.
2. **Sweep the docs site for PINNED versions** — these are NOT auto-updated:
   - `docs/02-quick-start/index.md` — the `npm install @agent-assembly/sdk@<X>`
     command is pinned to an explicit version.
   - `docs/09-examples/*.md` — each states the example "depends only on
     `@agent-assembly/sdk` (version `<X>`)".

   Find every occurrence with `git grep -nE '0\.0\.1-beta\.[0-9]+' docs/` (adjust
   the pattern to the live series) and bump each to the new version.
3. **New-feature example pins are a forward-reference (the trap).** An example
   that uses a feature added *after* the last published tag must pin the release
   that actually ships that feature — not the previous version it was written
   against. Verify which versions already exist upstream before pinning: a path
   that errors under `git cat-file -e <last-published-tag>:<path>` was absent at
   that tag, so its example must pin the **new** version, not the old one. This is
   the same class of miss as the python-sdk agno/haystack/smolagents example pins.
4. **Leave the Docusaurus channel config alone.** `website/versions.json`,
   `website/versionChannels.json`, and the `website/versioned_docs/**` snapshots
   are auto-managed by the `version-docs` snapshot job (see "What is auto-handled").
   Do not hand-edit them on the release-prep PR.

The canonical, full version-sweep procedure is the `agent-assembly` core
`release-docs-sync` skill; this runbook is the node slice of it.

## Coordinated release — operating procedure

Runs against `ai-agent-assembly/node-sdk`. Assumes the `agent-assembly` core tag
is being / has been cut by that repo's `/release-tag-cut`.

0. **Sync docs version refs + example pins** per the section above, on the
   release-prep PR, before the core tag is cut.

1. **Confirm the upstream Release exists.** The downstream dispatch only fires
   after `agent-assembly`'s Release object is published:
   `gh release view <core-tag> --repo ai-agent-assembly/agent-assembly`.
2. **Confirm the `aa-ffi-pin` auto-bump PR merged here.** Per the SOP, the
   `bot/aa-ffi-pin-<tag>` PR (which aligns `master`'s `aa-sdk-client` SHA with
   the new core tag) must be merged **before** node-sdk publishes, so the SDK
   ships the content users expect from that version label.
3. **Watch the triggered run.** `gh run list --repo ai-agent-assembly/node-sdk
   --workflow release-node.yml` then `gh run watch <id>`. Confirm: binaries
   downloaded for all four targets, all five `package.json` bumped, runtime
   sub-packages published before the root SDK, and the `v<version>` tag + GitHub
   Release cut.
4. **If the run failed partway**, re-drive it for the same tag via
   `workflow_dispatch` (`/sdk-only-release` for `main-only`, or `publish_mode=all`
   with the same `binary_source_tag` for a full re-publish). Do **not** re-cut the
   core tag to retry npm — npm versions are immutable.
5. **Validate** (next section) before declaring the release done.

## Validating a published release

npm publishes are immutable, so validation is read-only confirmation:

1. **Root SDK is live at the expected version:**
   `npm view @agent-assembly/sdk@<version> version`.
2. **All four runtime sub-packages are live at the same version** (coordinated
   path) and the SDK pins them:
   ```bash
   for p in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
     npm view "@agent-assembly/runtime-${p}@<version>" version
   done
   npm view @agent-assembly/sdk@<version> optionalDependencies
   ```
   On the coordinated path the four `optionalDependencies` entries equal
   `<version>`; on the `main-only` path they equal `<binary_source_tag-no-v>`
   (never `workspace:*` — that marker is local-dev only and is unresolvable on
   npm).
3. **dist-tag points where intended:** `npm dist-tag ls @agent-assembly/sdk`
   (e.g. a pre-release should be under `alpha`/`rc`, not `latest`). The workflow
   sets the dist-tag at publish time from the SemVer pre-release identifier;
   promoting an existing version to another tag is a separate, operator-run
   `npm dist-tag add` from an authenticated shell.
4. **Install smoke-check** on at least one platform: a clean `npm i
   @agent-assembly/sdk@<version>` must resolve the matching runtime
   `optionalDependency` without "no matching version" warnings.
5. **GitHub Release + git tag** `v<version>` exist on this repo:
   `gh release view v<version> --repo ai-agent-assembly/node-sdk`.

## What is auto-handled (do NOT manually run)

`release-node.yml` owns these end-to-end; hand-running them collides with its
state machine:

- `npm publish` for the root SDK or any runtime sub-package.
- The five-package version bump and the `optionalDependencies` rewrite.
- Downloading + staging the `aasm-*.tar.gz` binaries.
- The post-publish `v<version>` git tag + GitHub Release.
- The Docusaurus docs-version snapshot PR (`version-docs` job).
- The SonarCloud `sonar.projectVersion`. `quality-report.yml` overrides the
  `sonar-project.properties` value with `-Dsonar.projectVersion=<package.json
  version>` at scan time, so the quality gate auto-advances once the five
  `package.json` files are bumped — no manual `sonar.projectVersion` bump is
  required on the release path (AAASM-2774). Keep the static fallback in
  `sonar-project.properties` roughly in step with `package.json` so the gate
  never falls back to `0.0.0` ("Not computed") if the scan ever runs without the
  CI override.

## Detailed references

- **Full docs-version sweep procedure** (the canonical checklist; this runbook is
  the node slice) → `agent-assembly` `/release-docs-sync`.
- **SDK-only republish** (the `workflow_dispatch` `main-only` escape hatch and
  the 2026-06-15 release-coordination SOP) → `/sdk-only-release`.
- **Upstream core tag cut** → `agent-assembly` `/release-tag-cut`.
- **Cross-channel propagation matrix** → `agent-assembly` `/release-validate-channels`.
