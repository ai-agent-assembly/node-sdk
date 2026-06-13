# node-sdk release runbook

> Step-by-step procedure for cutting a `@agent-assembly/sdk` release.
> Companion to `agent-assembly/docs/release/RUNBOOK.md` for the coordinated
> product-line release path. Tracked under AAASM-2851 (decoupled release
> story) and AAASM-2858 (this runbook).

This runbook assumes the operator has push rights to
`AI-agent-assembly/node-sdk` and that the five `@agent-assembly/*` npm
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
  --ref master \
  -f npm_version=0.0.1-alpha.9 \
  -f binary_source_tag=v0.0.1-alpha.9 \
  -f publish_mode=all
```

What happens:

1. The workflow checks out master and stamps `npm_version` on the root
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

## 2. Verification

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

## 3. Recovery — when a publish fails

npm publishes are effectively immutable. A failed publish that uploaded
partial state (e.g. some runtime sub-packages but not `@agent-assembly/sdk`)
is recovered by bumping `npm_version` to the next available slot and
re-running the workflow with the same `binary_source_tag`. Do not attempt
`npm unpublish` — the 72-hour grace window is not a contract and other
operators may already be depending on the partial state.
