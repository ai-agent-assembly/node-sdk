# sdk-only-release — worked examples

## Worked example — `@agent-assembly/sdk@0.0.1-alpha.8.1`

The live AAASM-2862–2867 validation run. Use it as a concrete template
for any future SDK-only dispatch.

**Context.** The 4 runtime sub-packages from the `v0.0.1-alpha.8`
GitHub Release were healthy on npm. An SDK-side fix needed to ship as
`@agent-assembly/sdk@0.0.1-alpha.8.1` with no change to the binaries.
The `.1` suffix preserves pin-to-exact installs of `0.0.1-alpha.8`.

**1. Dispatch the dry-run.**

```bash
gh workflow run release-node.yml \
  --repo ai-agent-assembly/node-sdk \
  --ref master \
  -f npm_version=0.0.1-alpha.8.1 \
  -f binary_source_tag=v0.0.1-alpha.8 \
  -f publish_mode=main-only \
  -f dry-run=true
```

**2. Confirm the Pre-flight output.** The **Bump main SDK version only
(main-only mode)** step rewrote `optionalDependencies` from
`workspace:*` to `0.0.1-alpha.8` (the `binary_source_tag` with the
leading `v` stripped). The **Pre-flight verify runtime sub-packages
exist on npm** step then resolved all four pinned runtimes against the
registry. This step ordering is the AAASM-2867 fix — if Bump ran
after Pre-flight, the dry-run failed because `workspace:*` is not a
valid npm version selector.

The dry-run completed green; no artifacts were pushed to the registry.

**3. Re-dispatch with `dry-run=false`.**

```bash
gh workflow run release-node.yml \
  --repo ai-agent-assembly/node-sdk \
  --ref master \
  -f npm_version=0.0.1-alpha.8.1 \
  -f binary_source_tag=v0.0.1-alpha.8 \
  -f publish_mode=main-only \
  -f dry-run=false
```

The real publish completed green.

**4. Verify on the registry.**

```bash
npm view @agent-assembly/sdk@0.0.1-alpha.8.1 version
npm view @agent-assembly/sdk@0.0.1-alpha.8.1 optionalDependencies
```

The version metadata appeared on npm; `optionalDependencies` pinned to
`0.0.1-alpha.8` for every `@agent-assembly/runtime-*` entry.

**5. Promote the dist-tag from an authenticated terminal.** The
operator ran the following from their own npm-authenticated shell —
the skill named the command but did **not** run it:

```bash
npm dist-tag add @agent-assembly/sdk@0.0.1-alpha.8.1 alpha
```
