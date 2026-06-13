# AAASM-2851 — node-sdk verification report

**Parent Story:** AAASM-2851 — Decouple SDK releases from agent-assembly core
**Subtask:** AAASM-2859 — Verify acceptance criteria
**Master HEAD verified:** node-sdk `161a62f` (post-AAASM-2858)
**Date:** 2026-06-13

## Approach

This report covers static verification of node-sdk's release workflow at master HEAD. The implementation chain (AAASM-2852 → AAASM-2853 → AAASM-2854 → AAASM-2855) is fully merged. Each subtask shipped with its own CI-green PR + AC review. This report consolidates the verification matrix across both SDKs.

### Why static verification (and not live dispatch)

The verification matrix's happy-path rows (R1, R2, H1, H2) would publish real versions to npm or PyPI. The ticket explicitly permits "documented justification for being unverifiable in the available environment" when verdaccio / TestPyPI / fork-with-registry setup is absent. Static trace through the merged workflow is high-quality verification for YAML changes because:

1. `actionlint` passed on every merged subtask PR (CI's `quality` job is the project's enforcement).
2. Every AC maps to a specific bash conditional or validation block I can quote and trace.
3. Each subtask's unit work passed its own AC review with a Claude Code review comment.

### Available proof artifacts

* PR review comments (commit-level + AC-level verification): linked per row.
* Workflow file at master HEAD: `.github/workflows/release-node.yml`.
* Sibling python-sdk report: `python-sdk:verification-reports/AAASM-2851/summary.md`.

---

## Verification matrix

| Row | Repo | Trigger | Inputs | Expected | Verdict |
|---|---|---|---|---|---|
| R1 | node-sdk | `repository_dispatch` | `client_payload.release_tag = v0.0.1-alpha.8` | 5 packages publish at `0.0.1-alpha.8` | ✅ Static — traced |
| R2 | python-sdk | `repository_dispatch` | (same shape) | wheels + sdist at `0.0.1a8` | ✅ Static — see python-sdk report |
| H1 | node-sdk | `workflow_dispatch` | `npm_version=0.0.1-alpha.8.1`, `binary_source_tag=v0.0.1-alpha.8`, `publish_mode=main-only` | Only main SDK publishes at `0.0.1-alpha.8.1`; runtime steps SKIPPED | ✅ Static — traced |
| H2 | node-sdk | `workflow_dispatch` | same but `publish_mode=all` | 5 packages bump + publish at `0.0.1-alpha.8.1` | ✅ Static — traced |
| H3 | python-sdk | `workflow_dispatch` | `pypi_version=0.0.1a8.post1`, `binary_source_tag=v0.0.1-alpha.8`, `dry-run=true` | wheel built, no upload | ✅ Static — see python-sdk report |
| F1 | node-sdk | `workflow_dispatch` | `publish_mode=main-only` + runtime pin to non-existent version | Pre-flight fails fast | ✅ Live — [F1.log](./F1.log) |
| F2 | python-sdk | `workflow_dispatch` | `dry-run=false`, no `pypi_version` | Resolve fails fast | ✅ Static — see python-sdk report |
| F3 | node-sdk | `workflow_dispatch` | `npm_version=foo.bar` | Resolve validation fails | ✅ Static — traced |
| F4 | python-sdk | `workflow_dispatch` | `pypi_version=0.0.1-alpha.8.1` (hyphen) | PEP 440 validation fails | ✅ Static — see python-sdk report |

**Result: 9/9 ✅** (5 traced in this report, 4 in python-sdk's sibling report).

---

## Per-row traces (node-sdk rows)

### R1 — `repository_dispatch` coordinated 5-package publish

**Trigger:** simulated `gh api repos/AI-agent-assembly/node-sdk/dispatches -f event_type=agent-assembly-release-published -f 'client_payload[release_tag]=v0.0.1-alpha.8'`.

**Trace through `.github/workflows/release-node.yml` at master HEAD:**

1. Workflow fires on `repository_dispatch.types: [agent-assembly-release-published]` (line 24).
2. `Resolve release tag` step's `repository_dispatch` branch (line 96 onwards):
   ```bash
   binary_source_tag="$DISPATCH_PAYLOAD_TAG"   # = v0.0.1-alpha.8
   npm_version="${DISPATCH_PAYLOAD_TAG#v}"      # = 0.0.1-alpha.8
   publish_mode="all"                            # hard-coded for coordinated path
   ```
3. Validation passes (both formats match the semver patterns).
4. `Download aasm binaries` step's `if: steps.tag.outputs.publish_mode == 'all'` evaluates true → step runs.
5. `Stage runtime binaries` step similarly runs.
6. `Bump versions across the 5 packages` runs (also `if: 'all'`).
7. `Pre-flight verify runtime sub-packages exist on npm` (`if: 'main-only'`) is SKIPPED — correct, this only runs for main-only.
8. `Bump main SDK version only (main-only mode)` (`if: 'main-only'`) is also SKIPPED.
9. `Build main SDK` → `Publish 4 runtime sub-packages` (`if: 'all'`) → `Publish main @agent-assembly/sdk` (always runs).
10. `version-docs` job's `needs: publish` chain fires; uses `NPM_VERSION = 0.0.1-alpha.8` for the snapshot label (per AAASM-2855).

**Behavior identical to pre-AAASM-2851 coordinated release** except for one observable: the docs snapshot label drops the leading `v` (was `version-v0.0.1-alpha.8`, now `version-0.0.1-alpha.8`). This is the AAASM-2855 callout — semantically correct because npm versions are unprefixed.

**Verdict: ✅** Coordinated release path preserved.

### H1 — main-only SDK hotfix

**Trigger:** `gh workflow run release-node.yml --repo AI-agent-assembly/node-sdk --ref master -f npm_version=0.0.1-alpha.8.1 -f binary_source_tag=v0.0.1-alpha.8 -f publish_mode=main-only`

**Trace:**

1. Workflow fires on `workflow_dispatch`.
2. `Resolve release tag` step's `workflow_dispatch` branch:
   ```bash
   binary_source_tag="v0.0.1-alpha.8"  # from DISPATCH_BINARY_TAG
   npm_version="0.0.1-alpha.8.1"        # from DISPATCH_NPM_VERSION
   publish_mode="main-only"             # from DISPATCH_PUBLISH_MODE
   ```
3. Validations pass.
4. `Pre-flight verify runtime sub-packages exist on npm` (`if: 'main-only'`) runs:
   - Reads `package.json.optionalDependencies['@agent-assembly/runtime-*']`.
   - For each pinned version, runs `npm view <name>@<version> version`.
   - At master HEAD, all 4 runtime-* are pinned to `0.0.1-alpha.8` which already exists on npm from the coordinated alpha-8 release. Pre-flight passes.
5. `Download aasm binaries` (`if: 'all'`) is SKIPPED.
6. `Stage runtime binaries` (`if: 'all'`) is SKIPPED.
7. `Bump main SDK version only (main-only mode)` (`if: 'main-only'`) runs — writes `0.0.1-alpha.8.1` to root `package.json.version`. Does NOT touch the 4 runtime sub-package `package.json`s. Does NOT rewrite `optionalDependencies`.
8. `Bump versions across the 5 packages` (`if: 'all'`) is SKIPPED.
9. `Build main SDK` runs.
10. `Publish 4 runtime sub-packages` (`if: 'all'`) is SKIPPED.
11. `Publish main @agent-assembly/sdk` (always runs) publishes `@agent-assembly/sdk@0.0.1-alpha.8.1` to npm.
12. `version-docs` job runs (no gate as of AAASM-2855) → cuts a docs snapshot at `version-0.0.1-alpha.8.1` with `Bundled aasm: v0.0.1-alpha.8` metadata.

**Net npm state after H1:**
- New: `@agent-assembly/sdk@0.0.1-alpha.8.1`
- Unchanged: `@agent-assembly/runtime-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}@0.0.1-alpha.8` (the existing pins)
- Users running `npm install @agent-assembly/sdk@0.0.1-alpha.8.1` get the new SDK; `optionalDependencies` resolve to the existing runtime-* on npm.

**Verdict: ✅** SDK-only hotfix path produces the expected isolated npm publish.

### H2 — workflow_dispatch all-mode (override coordinated path)

**Trigger:** `gh workflow run release-node.yml ... -f npm_version=0.0.1-alpha.8.1 -f binary_source_tag=v0.0.1-alpha.8 -f publish_mode=all`

**Trace:** Same path as R1 but with explicit `workflow_dispatch` values — i.e. the operator equivalent of repository_dispatch. All 5 packages bump to `0.0.1-alpha.8.1` (not the binary_source_tag's `0.0.1-alpha.8`), runtime publish runs, main SDK publish runs.

**Note on the contract:** H2 demonstrates that an operator can dispatch a coordinated-style publish at a version distinct from the agent-assembly tag. This isn't the documented hotfix path (which is main-only), but the workflow supports it. Useful for re-pinning runtime to a new SDK-track version.

**Verdict: ✅** All-mode workflow_dispatch produces the expected 5-package publish.

### F1 — main-only pre-flight failure on missing runtime pin

**Trigger:** `gh workflow run release-node.yml ... -f publish_mode=main-only` against a branch whose `package.json.optionalDependencies['@agent-assembly/runtime-linux-x64']` is set to a version that doesn't exist on npm (e.g. `99.99.99-fake`).

**Trace:**

1. Resolve passes (npm_version + binary_source_tag valid).
2. `Pre-flight verify runtime sub-packages exist on npm` runs.
3. For the bad pin: `npm view @agent-assembly/runtime-linux-x64@99.99.99-fake version` returns exit-1.
4. The Node script catches the exception, logs:
   ```
   ::error::main-only publish blocked — @agent-assembly/runtime-linux-x64@99.99.99-fake is not on npm. Use publish_mode=all to publish the runtime sub-packages alongside the SDK.
   ```
5. `process.exit(1)` → step fails → no subsequent step runs → no npm publish.

**Trace source:** Commit `8e97711` (`✨ (release-node): Add pre-flight check that runtime sub-packages exist on npm`) — see review comment on PR #113.

**Live verification (AAASM-2865):** dispatched the workflow against a temporary branch (`verify/AAASM-2865/f1-live`, since deleted) whose root `package.json` `optionalDependencies` set `runtime-linux-x64` to `99.99.99-fake` and left the other 3 runtime-* pinned at the existing `0.0.1-alpha.8` publish. Inputs: `npm_version=0.0.1-alpha.8.1`, `binary_source_tag=v0.0.1-alpha.8`, `publish_mode=main-only`.

- Dispatched run: <https://github.com/ai-agent-assembly/node-sdk/actions/runs/27471607887>
- Captured log: [`F1.log`](./F1.log)

Key excerpt from the captured log (pre-flight step output):

```
Resolved binary_source_tag=v0.0.1-alpha.8 npm_version=0.0.1-alpha.8.1 publish_mode=main-only
...
OK: @agent-assembly/runtime-darwin-arm64@0.0.1-alpha.8 exists on npm
OK: @agent-assembly/runtime-darwin-x64@0.0.1-alpha.8 exists on npm
OK: @agent-assembly/runtime-linux-arm64@0.0.1-alpha.8 exists on npm
##[error]main-only publish blocked — @agent-assembly/runtime-linux-x64@99.99.99-fake is not on npm. Use publish_mode=all to publish the runtime sub-packages alongside the SDK.
##[error]Process completed with exit code 1.
```

The pre-flight iterates all 4 entries and emits the exact AC-prescribed error string for the one missing pin; exit 1 stops the job at the pre-flight step (no download / stage / bump / build / publish step ran). No npm publish occurred.

**Verdict: ✅** Fail-fast on bad runtime-* pin works as designed (live-confirmed).

### F3 — invalid `npm_version` rejection

**Trigger:** `gh workflow run release-node.yml ... -f npm_version=foo.bar -f binary_source_tag=v0.0.1-alpha.8`

**Trace:**

1. `Resolve release tag` step receives `DISPATCH_NPM_VERSION=foo.bar`.
2. Bash validation block (commit `a8f2c4e`):
   ```bash
   if [[ ! "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
     echo "::error::npm_version 'foo.bar' does not match X.Y.Z semver pattern (must NOT include leading v)"
     exit 1
   fi
   ```
3. Step exits with error. Pre-flight, Bump, Build, Publish — all skipped because Resolve failed.

**Verdict: ✅** Validation fires before any publish-side work.

---

## Cross-row consistency check

All 5 node-sdk rows trace through the SAME Resolve step at master HEAD. The `publish_mode` output emitted by Resolve is the single source of truth for which steps run. There's no path where `publish_mode='all'` and main-only gating leak across each other — the `if:` conditions on the 4 gated steps + 2 new steps are mutually exclusive on `'all'` vs `'main-only'`.

## Limitations acknowledged

- **No live dispatch for happy-path rows:** would publish real versions or burn CI minutes. Verdaccio / TestPyPI / fork-with-registry setup is out of scope here. Adding a `dry-run` boolean input on node-sdk (parity with python-sdk) would enable safe live H1/H2 verification in a follow-up.
- **F1 setup invasive but completed:** AAASM-2865 closed this row's "Live ✅" cell by dispatching against a temp `verify/AAASM-2865/f1-live` branch with a deliberately bad pin. The temp branch was deleted after the failing-run log was captured to `F1.log`. Static trace through the pre-flight code remains in this report for self-contained reading.
- **Snapshot label observable for coordinated releases:** the AAASM-2855 callout (`version-v0.0.1-alpha.8` → `version-0.0.1-alpha.8`) is documented in PR #114's review. Worth verifying on the next coordinated release tag fire.

## Sign-off

All 5 node-sdk rows of the AAASM-2851 verification matrix pass static verification. The merged subtask chain (AAASM-2852 + AAASM-2853 + AAASM-2854 + AAASM-2855) collectively delivers the SDK-only hotfix capability with the back-compat scaffolding cleaned up.

— Claude Code, on behalf of AAASM-2859
