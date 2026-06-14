---
name: sdk-only-release
description: Publish an SDK-only @agent-assembly/sdk release (no agent-assembly core bump) via release-node.yml workflow_dispatch.
---

# sdk-only-release

Publish a new `@agent-assembly/sdk` version on npm **without** cutting a new
`agent-assembly` core tag, by dispatching `release-node.yml` directly with
`workflow_dispatch` inputs.

This skill codifies the dispatch interface that landed via the AAASM-2851
chain (AAASM-2862–2867 alpha-8.1 validation). The mechanism is identical for
every SDK-only publish — **the trigger reason is broader than "hotfix"**.

## Quick reference — canonical invocation

```bash
gh workflow run release-node.yml \
  --repo ai-agent-assembly/node-sdk \
  --ref master \
  -f npm_version=<X> \
  -f binary_source_tag=<Y> \
  -f publish_mode=main-only \
  -f dry-run=true
```

Replace `<X>` with the bare semver to publish (no leading `v`) and `<Y>`
with the existing `agent-assembly` tag (with leading `v`) whose binaries
should back the runtime sub-package pins. Always run with `dry-run=true`
first; re-dispatch with `dry-run=false` once the dry-run is green.

## When to use

Use this skill whenever `@agent-assembly/sdk` needs a republish for **any
reason that does not require cutting a new `agent-assembly` tag**. The
JavaScript / TypeScript surface needs a new published version and the
`aasm` binary + the 4 runtime sub-packages on npm are healthy. Common
cases:

- **Hotfix** — bug fix in `src/`, no Rust change.
- **New SDK feature** — TS-only feature that does not touch the protocol.
- **Refactor** — SDK internal cleanup without core changes.
- **Dependency bump** — npm dep upgrade contained to the SDK package.
- **Doc rebuild for a published JS API** — re-cut to ship a corrected README
  / typings file.
- **Pre-release iteration** — `0.0.1-alpha.8.1`, `.2`, … between coordinated
  releases.

## When NOT to use

- **A new `agent-assembly` tag is being cut.** The upstream `release.yml`
  fires the `repository_dispatch` that drives a full coordinated SDK
  republish (and the docs cascade) automatically. Manually dispatching
  this skill at the same time double-publishes and conflicts on the
  npm version slot.
- **The change touches the `aasm` binary, a shared Rust crate, or a
  wire-protocol surface.** The runtime sub-packages must re-publish in
  lockstep with the binary — run the coordinated `agent-assembly`
  release flow so all five npm packages move together.
- **Operator wants to bump only the runtime binaries.** This is not an
  SDK-only release; do not pick `publish_mode=all` to chase it. Cut a
  new `agent-assembly` tag so the binaries are sourced authoritatively
  from a GitHub Release.

Cross-reference: [`docs/release/RUNBOOK.md`](../../../docs/release/RUNBOOK.md)
§ "SDK-only release".

## How to use

Dispatch `release-node.yml` from the `node-sdk` repository with
`workflow_dispatch`. The canonical invocation is:

```bash
gh workflow run release-node.yml \
  --repo ai-agent-assembly/node-sdk \
  --ref master \
  -f npm_version=<X> \
  -f binary_source_tag=<Y> \
  -f publish_mode=main-only \
  -f dry-run=true
```

Three operator-side rules govern every dispatch:

1. **Dry-run first, always.** Re-dispatch with `dry-run=false` only after
   the dry-run is green and the Pre-flight output (especially the
   `optionalDependencies` rewrite) has been reviewed.
2. **Authenticated terminal for `npm dist-tag add`.** The workflow does
   not run `npm dist-tag add`; the operator runs it from their own
   npm-authenticated shell after the publish completes. The skill
   names the command but does not invoke it.
3. **`publish_mode=main-only` for SDK-only releases.** `all` is reserved
   for coordinated `agent-assembly` releases that re-cut binaries.

### The four `workflow_dispatch` input axes

`release-node.yml`'s `workflow_dispatch` exposes four inputs. **Each one
controls a distinct axis**; coupling them by accident is the source of every
common mistake.

| Input | Purpose | Common mistake |
|---|---|---|
| `npm_version` | Version published on npm for `@agent-assembly/sdk` (and runtime sub-packages in `all` mode). Bare semver, **no leading `v`**. e.g. `0.0.1-alpha.8.1`. | Confused with the agent-assembly binary tag. |
| `binary_source_tag` | The `agent-assembly` GitHub Release tag whose `aasm-*` tarballs feed the 4 runtime sub-packages. **Has the leading `v`.** e.g. `v0.0.1-alpha.8`. | Confused with `npm_version`; setting these equal defeats the whole point of an SDK-only release. |
| `publish_mode` | `all` = main SDK + 4 runtime sub-packages. `main-only` = only `@agent-assembly/sdk`; its `optionalDependencies` are rewritten to pin to runtime versions derived from `binary_source_tag` (the leading `v` stripped). | Picking `all` for an SDK-only release re-publishes the runtimes unnecessarily and burns a runtime version slot. |
| `dry-run` | `true` skips actual npm publish (and the docs-version snapshot). Builds still run; nothing reaches the registry. | Forgetting to run a dry-run first; or shipping the real publish before reviewing the Pre-flight output. |

**Rule of thumb for an SDK-only release**: `npm_version` and
`binary_source_tag` differ; `publish_mode=main-only`; do `dry-run=true`
first, then `dry-run=false`.

### Pre-conditions (verify before dispatching)

Run these checks first. Do not dispatch without all three.

1. **`npm_version` is higher than the latest published `@agent-assembly/sdk`
   and is not yet taken on the registry.** npm publishes are effectively
   immutable; re-using a version is a fatal error in the workflow's
   Pre-flight step.

   ```bash
   npm view @agent-assembly/sdk versions --json | tail -20
   npm view @agent-assembly/sdk@<npm_version> version  # must 404
   ```

2. **`binary_source_tag` is an existing `agent-assembly` tag with
   published GitHub Release assets**, and the corresponding
   `@agent-assembly/runtime-*@<binary_source_tag_no_v>` packages
   already exist on npm.

   ```bash
   gh release view <binary_source_tag> --repo ai-agent-assembly/agent-assembly
   for plat in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
     npm view "@agent-assembly/runtime-${plat}@${BINARY_SOURCE_TAG#v}" version
   done
   ```

3. **You have already run `dry-run=true` and reviewed the output** —
   particularly the Pre-flight step's optionalDependencies rewrite. (For
   the first attempt of any new `npm_version`, this is your first run; the
   second run flips `dry-run=false`.)

### Executable plan

1. **Dispatch the dry-run.**

   ```bash
   gh workflow run release-node.yml \
     --repo ai-agent-assembly/node-sdk \
     --ref master \
     -f npm_version=<X> \
     -f binary_source_tag=<Y> \
     -f publish_mode=main-only \
     -f dry-run=true
   ```

2. **Watch the run and surface the Pre-flight output.** Confirm:

   ```bash
   gh run watch --repo ai-agent-assembly/node-sdk
   ```

   - The **Bump main SDK version only (main-only mode)** step rewrote
     `optionalDependencies['@agent-assembly/runtime-*']` from `workspace:*`
     to the pinned `<binary_source_tag-no-v>` value.
   - The **Pre-flight verify runtime sub-packages exist on npm** step
     resolved all four pinned runtimes.
   - The publish steps skipped because `dry-run=true`.

3. **If dry-run is green, re-run with `dry-run=false`.**

   ```bash
   gh workflow run release-node.yml \
     --repo ai-agent-assembly/node-sdk \
     --ref master \
     -f npm_version=<X> \
     -f binary_source_tag=<Y> \
     -f publish_mode=main-only \
     -f dry-run=false
   ```

4. **Verify the published version.**

   ```bash
   npm view @agent-assembly/sdk@<X> version
   npm view @agent-assembly/sdk@<X> optionalDependencies
   ```

   The four runtime sub-package entries must pin to
   `<binary_source_tag-no-v>` (not `workspace:*`, not `<X>`).

## Post-conditions

- **dist-tag promotion is a separate, operator-driven step.** If `<X>` should
  become the default for the alpha channel, the operator runs from their own
  authenticated npm terminal:

  ```bash
  npm dist-tag add @agent-assembly/sdk@<X> alpha
  ```

  This skill names the command but does **not** run it — npm auth is the
  operator's responsibility.

- Workflow run is green; no operator follow-up is required for the publish
  itself.

## Known quirks (encode these — do not relearn them)

### Bump step must run before Pre-flight

AAASM-2867: the Pre-flight step historically read
`optionalDependencies['@agent-assembly/runtime-*']` literally as
`workspace:*` from `package.json` and failed because `workspace:*` is not a
valid npm version selector. The fix in `main-only` mode is that the **Bump
main SDK version only** step now runs **before** Pre-flight and rewrites
those entries to the pinned `<binary_source_tag-no-v>` value. If a future
refactor reorders these steps, dry-run will fail on the same symptom. Keep
the Pre-flight check downstream of the Bump step.

### Docs cascade does NOT fire on `workflow_dispatch`

AAASM-2868 / AAASM-2869: the `deploy_release_documentation` job in the docs
cascade is gated on the `repository_dispatch` event. A
`workflow_dispatch`-triggered SDK-only release will **not** push docs.

This is intentional — coordinated releases drive the docs cascade. For an
SDK-only release that needs documentation updates, the docs PR is opened
and merged separately (the docs-version snapshot is also skipped by
`dry-run=true`, and on a real `dry-run=false` run the snapshot lands but
the cross-repo docs cascade does not).

### `npm_version` has no leading `v`; `binary_source_tag` does

The workflow validates both. A leading `v` on `npm_version` will fail the
input regex with `npm_version '…' does not match X.Y.Z semver pattern (must
NOT include leading v)`. A missing leading `v` on `binary_source_tag` will
fail with `binary_source_tag '…' does not match v*.*.* (semver) pattern`.

### `.N` suffix is the conventional SDK-only version slot

Use `<parent>.<N>` — e.g. `0.0.1-alpha.8.1`, `0.0.1-alpha.8.2` — so the
SDK-only version sorts after the parent SDK release and existing
pin-to-exact installs are unaffected until they explicitly upgrade.
Reserve clean `-alpha.N` slots for coordinated `agent-assembly` releases.
