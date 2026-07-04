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

## Release-coordination SOP — when agent-assembly is ALSO releasing

This is the canonical ordering rule operators MUST follow whenever `agent-assembly` is cutting a release in the same version cycle as this SDK. Codified after the 2026-06-15 incident (AAASM-3007).

### Case A — agent-assembly is ALSO releasing this version cycle

The SDK release MUST wait. Required order:

1. Cut the `agent-assembly` tag (e.g. `v0.0.1-beta.3`) and wait for its `Release` workflow to complete (build → publish → `notify-downstream`).
2. Wait for the auto-bump PR (`bot/aa-ffi-pin-<tag>`) to open on this repo (AAASM-2883 for node/python; AAASM-3006 extends the same fan-out to go-sdk).
3. Review + merge the auto-bump PR. This brings `master` in line with the `aa-sdk-client` SHA carried by the new agent-assembly tag.
4. ONLY THEN cut the SDK tag (matching version) — by tag-push OR `workflow_dispatch` — to fire this skill.

Do NOT pre-publish the SDK tag against the previous agent-assembly content. Doing so:

- Burns the version slot on the registry (npm / PyPI refuse re-publish).
- Means users installing that SDK version get content that does NOT carry the agent-assembly fix they expect.

### Case B — SDK-only release (no agent-assembly cut in this cycle)

This skill may be triggered freely via `workflow_dispatch`. No coordination required, because the existing `aa-sdk-client` SHA pin on `master` is already what we want to ship.

### Why this SOP exists (the 2026-06-15 incident)

On 2026-06-15 02:21 UTC, `@agent-assembly/sdk@0.0.1-beta.2` was published to npm via `workflow_dispatch` while `agent-assembly`'s latest release was still `v0.0.1-beta.1` (pre-AAASM-3000 IPC fix). The bundle on npm at version `0.0.1-beta.2` therefore does NOT carry the AAASM-3000 fix that users would reasonably expect from that version label. Same incident on PyPI at 02:22 UTC.

The fix is operator discipline (this SOP), not a workflow-code restriction — `workflow_dispatch` is kept open for legitimate Case B releases.

## Version-bump prep PR — required file footprint

Before the `workflow_dispatch` publish, land a **prep-only PR** advancing every
checked-in version literal to the new release. The `npm_version` dispatch input is
what stamps the published packages, but master must not lag it — a stale literal
drifts the SonarCloud gate and misleads the docs. **Bump ALL of the following in one
prep PR** (reference: rc.2 PR #205 / AAASM-3834). Missing any of these — especially
the docs pins — is the most common release-prep defect.

| File | What to change |
|---|---|
| `package.json` (root) | `"version": "<SemVer>"` (e.g. `0.0.1-rc.3`). **Only** the root package declares the SDK version |
| `sonar-project.properties` | `sonar.projectVersion=<SemVer>` (source-of-truth / local-scan fallback; never `0.0.0`) |
| `docs/02-quick-start/index.md` | bump the `npm install @agent-assembly/sdk@<old>` pin |
| `docs/09-examples/*.md` | bump the `@agent-assembly/sdk` version pin in every example that carries one (grep `0.0.1-rc`) |

**Do NOT touch** in the prep PR:
- The 4 `packages/runtime-*/package.json` sub-packages — they use `workspace:*` and
  `release-node.yml` writes their version from `npm_version` at publish time (AAASM-2854).
- `pnpm-lock.yaml` — the lockfile does not pin the project's own version; verify
  `pnpm install --frozen-lockfile` has no drift rather than regenerating.
- `website/versioned_docs/**`, `website/versions.json`, `website/versionChannels.json`
  — the docs-site version snapshot is generated by the release docs job, not the prep PR.

Always `grep -rn` the outgoing version across `docs/**` (excluding
`website/versioned_docs/`) to catch every literal before opening the PR; do not copy a
stale file list.

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
- The CI-side `sonar.projectVersion` override needs no action.
  `quality-report.yml` derives it from `package.json` at scan time
  (`-Dsonar.projectVersion=<version>`), so once `<npm_version>` is committed to
  `package.json` the quality gate tracks it automatically (AAASM-2774). CI never
  needs the literal — but you **still** bump `sonar.projectVersion` in
  `sonar-project.properties` to the new version as part of the version-bump prep
  commit: it is the source-of-truth / local-scan fallback and must track the
  release, never sitting at `0.0.0` ("Not computed"). Mirrors the core's
  `release-tag-cut` automation (AAASM-3819); this is the step rc.1 prep PRs
  missed.

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
