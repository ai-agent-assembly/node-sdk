---
name: sdk-only-release
description: Publish an SDK-only @agent-assembly/sdk release via the release-node.yml workflow_dispatch, without cutting a new agent-assembly core tag. Use when the Node SDK needs a republish for any reason that does not change the core binaries — a new SDK feature, refactor, dependency bump, bug fix, doc rebuild, or pre-release iteration — by supplying npm_version, binary_source_tag, publish_mode, and a dry-run-first dispatch.
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
reason that does not require cutting a new `agent-assembly` tag**: the
JavaScript / TypeScript surface needs a new published version and the
`aasm` binary + the 4 runtime sub-packages on npm are healthy. Common
cases: hotfix (bug fix in `src/`, no Rust change), new TS-only SDK feature,
SDK-internal refactor, npm dependency bump contained to the SDK package,
doc rebuild for a published JS API, or pre-release iteration
(`0.0.1-alpha.8.1`, `.2`, … between coordinated releases).

## When NOT to use

- **A new `agent-assembly` tag is being cut.** Upstream `release.yml` fires
  the `repository_dispatch` that drives a full coordinated SDK republish
  (and the docs cascade) automatically. Dispatching this skill at the same
  time double-publishes and conflicts on the npm version slot.
- **The change touches the `aasm` binary, a shared Rust crate, or a
  wire-protocol surface.** The runtime sub-packages must re-publish in
  lockstep with the binary — run the coordinated `agent-assembly` release
  flow so all five npm packages move together.
- **Operator wants to bump only the runtime binaries.** That is not an
  SDK-only release; do not pick `publish_mode=all` to chase it. Cut a new
  `agent-assembly` tag so the binaries are sourced authoritatively from a
  GitHub Release.

Cross-reference: [`docs/release/RUNBOOK.md`](../../../docs/release/RUNBOOK.md)
§ "SDK-only release".

## How to use

Dispatch `release-node.yml` from the `node-sdk` repository with
`workflow_dispatch` (canonical invocation above). The dispatch has four
input axes — `npm_version`, `binary_source_tag`, `publish_mode`, `dry-run` —
each controlling a distinct concern; see
[REFERENCE.md](REFERENCE.md) for the axis-by-axis table.

Three operator-side rules govern every dispatch:

1. **Dry-run first, always.** Re-dispatch with `dry-run=false` only after
   the dry-run is green and the Pre-flight output (especially the
   `optionalDependencies` rewrite) has been reviewed.
2. **Authenticated terminal for `npm dist-tag add`.** The workflow does not
   run `npm dist-tag add`; the operator runs it from their own
   npm-authenticated shell after the publish. The skill names the command
   but does not invoke it.
3. **`publish_mode=main-only` for SDK-only releases.** `all` is reserved
   for coordinated `agent-assembly` releases that re-cut binaries.

### Pre-conditions (verify before dispatching)

1. **`npm_version` is higher than the latest published `@agent-assembly/sdk`
   and not yet taken on the registry** (npm publishes are immutable):

   ```bash
   npm view @agent-assembly/sdk@<npm_version> version  # must 404
   ```

2. **`binary_source_tag` is an existing `agent-assembly` tag with published
   Release assets**, and the matching
   `@agent-assembly/runtime-*@<binary_source_tag_no_v>` packages exist on npm:

   ```bash
   gh release view <binary_source_tag> --repo ai-agent-assembly/agent-assembly
   for plat in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
     npm view "@agent-assembly/runtime-${plat}@${BINARY_SOURCE_TAG#v}" version
   done
   ```

3. **You have run `dry-run=true` and reviewed the optionalDependencies
   rewrite** (for a brand-new `npm_version`, this is your first run; the
   second flips `dry-run=false`).

### Executable plan

1. **Dispatch the dry-run** (canonical invocation above, `dry-run=true`).
2. **Watch the run** (`gh run watch --repo ai-agent-assembly/node-sdk`) and
   confirm: the **Bump main SDK version only (main-only mode)** step rewrote
   `optionalDependencies['@agent-assembly/runtime-*']` from `workspace:*` to
   the pinned `<binary_source_tag-no-v>`; the **Pre-flight verify runtime
   sub-packages exist on npm** step resolved all four pinned runtimes; the
   publish steps skipped because `dry-run=true`.
3. **If dry-run is green, re-run with `dry-run=false`.**
4. **Verify the published version:**

   ```bash
   npm view @agent-assembly/sdk@<X> version
   npm view @agent-assembly/sdk@<X> optionalDependencies
   ```

   The four runtime entries must pin to `<binary_source_tag-no-v>` (not
   `workspace:*`, not `<X>`).

### When done

- `@agent-assembly/sdk@<X>` is queryable on the registry with
  `optionalDependencies` pinned to `<binary_source_tag-no-v>`.
- The 4 runtime sub-packages were NOT republished (`publish_mode=main-only`).
- The docs cascade did NOT fire (`workflow_dispatch` emits no
  `repository_dispatch`); refresh docs separately if needed.
- dist-tag promotion is a separate operator step from an authenticated
  terminal: `npm dist-tag add @agent-assembly/sdk@<X> alpha`.

## Do NOT manually run

The workflow owns these end-to-end. Hand-runs collide with its state machine
and reproduce the AAASM-2867 class of failure:

- **`npm publish`** for `@agent-assembly/sdk` or any runtime sub-package.
- **`git tag` creation** — there is no new git tag for an SDK-only release.
- **The docs-version snapshot / cross-repo docs cascade** —
  `deploy_release_documentation` is gated on `repository_dispatch`; do not
  work around the gate.
- **Editing `optionalDependencies` in `package.json` by hand** — the Bump
  step rewrites every `@agent-assembly/runtime-*` entry; hand-edits race it.

## Detailed references

- Worked alpha-8.1 walk-through (live AAASM-2862–2867 run):
  [EXAMPLES.md](EXAMPLES.md)
- Input-axis detail table + known quirks (Bump-before-Pre-flight, docs
  cascade gate, `v`-prefix rules, `.N` suffix convention):
  [REFERENCE.md](REFERENCE.md)
