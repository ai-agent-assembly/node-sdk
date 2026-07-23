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
  --ref main \
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
  --ref main \
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

---

## Two cases — when to use this skill

The `sdk-only-release` skill's [SKILL.md SOP](SKILL.md#release-coordination-sop--when-agent-assembly-is-also-releasing) defines two release shapes. The worked example above (`alpha-8.1`) is a **Case B** scenario — SDK-only release with healthy binaries from the previous coordinated cycle. The walkthrough below shows the **Case A** coordinated cycle.

## Case A — coordinated cycle (wait for agent-assembly)

Worked example for the SOP. **Scenario**: operator wants to publish `@agent-assembly/sdk@0.0.1-beta.3` **alongside** agent-assembly `v0.0.1-beta.3` — both carry the same content cycle. The SOP requires the SDK dispatch to wait for the upstream tag + the auto-bump PR.

**1. Verify the agent-assembly tag exists and `release.yml` finished green.**

```bash
$ gh release view v0.0.1-beta.3 --repo ai-agent-assembly/agent-assembly \
    --json tagName,publishedAt
{"tagName":"v0.0.1-beta.3","publishedAt":"2026-..."}

$ gh run list --repo ai-agent-assembly/agent-assembly --workflow release.yml \
    --branch v0.0.1-beta.3 --limit 1 --json conclusion,name
[{"name":"Release","conclusion":"success"}]
```

If the release is missing or the run is still in progress, STOP — do not dispatch the SDK release yet.

**2. Verify the `bot/aa-ffi-pin-v0.0.1-beta.3` PR opened on this repo.**

```bash
$ gh pr list --repo ai-agent-assembly/node-sdk --head bot/aa-ffi-pin-v0.0.1-beta.3 \
    --json number,title,mergedAt
[{"number":NNN,"title":"🤖 (aa-ffi-node): Bump aa-sdk-client pin to v0.0.1-beta.3","mergedAt":null}]
```

If no PR is listed, the upstream `update-node-sdk-ffi-pin` job (AAASM-2883) hasn't run yet. Wait, then re-probe.

**3. Review + merge the auto-bump PR.** The PR moves `native/aa-ffi-node/Cargo.toml`'s `aa-sdk-client` rev to the new agent-assembly tag commit (and regenerates `Cargo.lock`). After merge, main carries the binary-matching SHA pin.

**4. ONLY NOW dispatch `release-node.yml`.** Same mechanics as the alpha-8.1 example above — `dry-run=true` first, then `dry-run=false`. Critically, use `binary_source_tag=v0.0.1-beta.3` (NOT the previous tag) so the runtime sub-packages resolve against the new agent-assembly Release, and `publish_mode=all` because this is a coordinated release with new binaries (the `main-only` mode is the Case B shape).

```bash
gh workflow run release-node.yml \
  --repo ai-agent-assembly/node-sdk \
  --ref main \
  -f npm_version=0.0.1-beta.3 \
  -f binary_source_tag=v0.0.1-beta.3 \
  -f publish_mode=all \
  -f dry-run=true
```

**5. Verify on the registry** (same probes as the alpha-8.1 example: `npm view @agent-assembly/sdk@0.0.1-beta.3 version`, `npm view @agent-assembly/sdk@0.0.1-beta.3 optionalDependencies`).

### Anti-example — what happens if you skip steps 1-3

This is the 2026-06-15 foot-gun the SOP prevents:

- **02:21 UTC** — operator dispatched `release-node.yml` with `npm_version=0.0.1-beta.2` while agent-assembly's latest release was still `v0.0.1-beta.1`. `binary_source_tag` defaulted to "latest agent-assembly release" → resolved to `v0.0.1-beta.1`. `dry-run` defaulted to false. **npm accepted the publish**, bundling the runtime sub-packages from the previous tag's GitHub Release.
- **09:36 UTC** — agent-assembly's actual `v0.0.1-beta.2` tag cut (commit `0aa9c945`, AAASM-3004) → `notify-downstream` fired the coordinated republish. `release-node.yml` tried to re-publish `0.0.1-beta.2` with the new content carrying the AAASM-3000 IPC fix. **npm 403'd** with `You cannot publish over the previously published versions: 0.0.1-beta.2`.
- **Net**: `@agent-assembly/sdk@0.0.1-beta.2` on npm carries the OLD content (no AAASM-3000 fix). The version slot is permanently burnt — npm allows unpublish within 72h but disallows republish at the same version even after unpublish. The fix had to ship under a different SDK version cut later.

The verification probes in steps 1-3 above make this impossible to repeat: any of them failing forces the operator to stop and resolve before dispatch.
