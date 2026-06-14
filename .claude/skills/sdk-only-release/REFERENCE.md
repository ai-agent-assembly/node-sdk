# sdk-only-release — reference

## Contents

- [The four `workflow_dispatch` input axes](#the-four-workflow_dispatch-input-axes)
- [Known quirks](#known-quirks)
  - [Bump step must run before Pre-flight](#bump-step-must-run-before-pre-flight)
  - [Docs cascade does NOT fire on `workflow_dispatch`](#docs-cascade-does-not-fire-on-workflow_dispatch)
  - [`npm_version` has no leading `v`; `binary_source_tag` does](#npm_version-has-no-leading-v-binary_source_tag-does)
  - [`.N` suffix is the conventional SDK-only version slot](#n-suffix-is-the-conventional-sdk-only-version-slot)

## The four `workflow_dispatch` input axes

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

## Known quirks

Encode these — do not relearn them.

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
