# node-sdk release runbook

> Step-by-step procedure for cutting a `@agent-assembly/sdk` release.
> Companion to `agent-assembly/docs/release/RUNBOOK.md` for the coordinated
> product-line release path. Tracked under AAASM-2851 (decoupled release
> story) and AAASM-2858 (this runbook).

This runbook assumes the operator has push rights to
`ai-agent-assembly/node-sdk` and that the five `@agent-assembly/*` npm
packages have `@agent-assembly/release-bot` configured as their npm
Trusted Publisher with the node-sdk repo + `release-node.yml` workflow path.

The node-sdk releases two flavours of artifact in one workflow run:

| Package | Contents |
| --- | --- |
| `@agent-assembly/sdk` | TypeScript / JavaScript source (ESM + CJS dual build) |
| `@agent-assembly/runtime-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}` | Per-platform `aasm` sidecar binary, downloaded from an agent-assembly GitHub Release |

The `@agent-assembly/sdk` package declares the 4 runtime sub-packages in
`optionalDependencies`. npm resolves the matching platform at install time.

---

## 1. Coordinated release (the default path)

The coordinated release publishes all 5 packages at the same version, in
lock-step with an agent-assembly tag. This is the path that fires
automatically when `agent-assembly`'s `release.yml` sends a
`repository_dispatch` event after a tag push — see
`agent-assembly/docs/release/RUNBOOK.md` section 3 for the dispatcher
contract. To dispatch manually:

```bash
gh workflow run release-node.yml \
  --repo ai-agent-assembly/node-sdk \
  --ref main \
  -f npm_version=0.0.1-alpha.9 \
  -f binary_source_tag=v0.0.1-alpha.9 \
  -f publish_mode=all
```

What happens:

1. The workflow checks out main and stamps `npm_version` on the root
   `package.json`'s `version` field and on each `optionalDependencies`
   entry pointing at `@agent-assembly/runtime-*`.
2. The 4 platform `aasm-*.tar.gz` binaries from the
   `binary_source_tag` agent-assembly GitHub Release are downloaded and
   staged into each runtime sub-package.
3. Each runtime sub-package is published to npm at `npm_version`.
4. The main `@agent-assembly/sdk` package is built (ESM + CJS) and published
   to npm at `npm_version`.

Use coordinated releases whenever the change touches the `aasm` binary,
any shared Rust crate, or a wire-protocol-level surface that spans the
SDK and the sidecar. This is the normal product-line cadence.

## 2. SDK-only hotfix mode

If only the JavaScript surface of `@agent-assembly/sdk` needs a fix (the
`aasm` sidecar binary and the runtime sub-packages are healthy), you can
publish a new SDK version **without** cutting a new agent-assembly tag.

### When to use

- A bug exists only in the TypeScript / JavaScript code in `src/`.
- The bundled `aasm` binary (in the 4 runtime sub-packages) is correct.
- You want to ship the fix fast without re-publishing 14 Rust crates,
  rebuilding Docker images, opening a Homebrew tap PR, etc.

### How to dispatch

```bash
gh workflow run release-node.yml \
  --repo ai-agent-assembly/node-sdk \
  --ref main \
  -f npm_version=0.0.1-alpha.8.1 \
  -f binary_source_tag=v0.0.1-alpha.8 \
  -f publish_mode=main-only
```

What happens:

1. The workflow runs against main.
2. `npm_version` (e.g. `0.0.1-alpha.8.1`) is what gets stamped on
   `@agent-assembly/sdk`'s `package.json`.
3. `binary_source_tag` (e.g. `v0.0.1-alpha.8`) is the agent-assembly
   GitHub Release whose `aasm-*` binaries are bundled — but in
   `main-only` mode they're not actually downloaded because no runtime
   sub-package publishes. The input is still required so the pre-flight
   check can verify the matching `@agent-assembly/runtime-*` already
   exist on npm at that version.
4. `publish_mode=main-only` causes the workflow to **skip** the 4 runtime
   sub-package publish steps. The 4 runtime packages stay at their
   existing `0.0.1-alpha.8` versions on npm.
5. Only `@agent-assembly/sdk@0.0.1-alpha.8.1` lands on npm.
6. Users running `npm install @agent-assembly/sdk@0.0.1-alpha.8.1` get the
   new SDK; their `optionalDependencies` resolve to the existing
   `@agent-assembly/runtime-*@0.0.1-alpha.8` on npm.

### When NOT to use (use the coordinated agent-assembly release instead)

- A bug exists in the `aasm` binary or any shared Rust crate.
- New features that span SDK + binary (e.g. a new gRPC method).
- Routine version bumps that should ship across the whole product line.

### Version naming convention

Use a `.N` suffix on the parent SDK version: `0.0.1-alpha.8.1`,
`0.0.1-alpha.8.2`, etc. Reserve `0.0.1-alpha.9` (and other clean
`-alpha.N` slots) for coordinated agent-assembly releases. The `.N`
suffix is a valid semver pre-release identifier and sorts after the bare
`0.0.1-alpha.8` so existing pin-to-exact installs stay on the parent
version until they explicitly upgrade.

### Pre-flight checks

The workflow runs a pre-flight check before publishing that calls
`npm view @agent-assembly/runtime-<platform>@<binary_source_tag-stripped-v>`
for each of the 4 sub-packages. This verifies that the
`optionalDependencies['@agent-assembly/runtime-*']` versions currently
listed in `package.json` actually exist on npm. If they don't (e.g.
you're trying to publish a main-only update with `optionalDependencies`
pointing at a future runtime version that hasn't been published yet),
the workflow fails fast before touching the `@agent-assembly/sdk`
publish step.

The pre-flight also confirms that `npm_version` itself does **not** yet
exist on the `@agent-assembly/sdk` registry entry — npm publishes are
effectively immutable within minutes of upload, so re-publishing the
same version is treated as a fatal user error rather than a no-op.

## 3. Automatic aa-sdk-client pin bump (from agent-assembly)

After each `agent-assembly` release, `agent-assembly`'s `release.yml`
(`update-node-sdk-ffi-pin` job) **auto-opens a bot PR on this repo** that
bumps the `aa-sdk-client` git-SHA pin in `native/aa-ffi-node/Cargo.toml` to
the just-tagged commit.

A few things to keep in mind about that PR:

- **Merging it does NOT republish the npm package.** `release-node.yml`
  triggers only on `repository_dispatch`
  (`agent-assembly-release-published`) and `workflow_dispatch` — never on
  `push`. The npm publish already happened at agent-assembly tag time via
  the coordinated `repository_dispatch` fan-out (section 1).
- The bump PR is **source-sync only**: it keeps the FFI shim's pinned
  `aa-sdk-client` current so the next release — or any from-source build —
  compiles against the right revision.
- To avoid the one-cycle source lag (the SDK published at vX was built from
  the *previous* pin), merge the bump PR **before** the next agent-assembly
  tag is cut.

See `agent-assembly/docs/release/RUNBOOK.md` sections 3 and 8 for the
dispatcher and source-pin contract on the agent-assembly side.

## 4. Verification

After the workflow completes, verify on the npm registry:

```bash
npm view @agent-assembly/sdk@<npm_version> version
npm view @agent-assembly/sdk@<npm_version> optionalDependencies
```

For coordinated releases, also verify each runtime sub-package landed:

```bash
for plat in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  npm view "@agent-assembly/runtime-${plat}@<npm_version>" version
done
```

For SDK-only hotfix runs, only the first command should return a value;
the four runtime sub-packages stay at their previous `binary_source_tag`
version on npm.

### Post-release checks

- [ ] **AAASM-2855 carryover:** verify the docs-version PR's snapshot
  directory is named `version-<npm_version>` (e.g.
  `website/versioned_docs/version-0.0.1-alpha.8/`) — **NOT**
  `version-v0.0.1-alpha.8`. AAASM-2855 intentionally dropped the leading
  `v` so the snapshot label matches the npm semver; if you see the `v`
  back, the AAASM-2855 refactor regressed somewhere in the
  `version-docs` job.

## 5. Recovery — when a publish fails

npm publishes are effectively immutable. A failed publish that uploaded
partial state (e.g. some runtime sub-packages but not `@agent-assembly/sdk`)
is recovered by bumping `npm_version` to the next available slot and
re-running the workflow with the same `binary_source_tag`. Do not attempt
`npm unpublish` — the 72-hour grace window is not a contract and other
operators may already be depending on the partial state.

If the failure is in the pre-flight (e.g. the runtime sub-packages don't
yet exist on npm at the expected `binary_source_tag` version), fix the
underlying coordination problem first — usually that means running the
coordinated release for `binary_source_tag` before attempting the
SDK-only hotfix.
