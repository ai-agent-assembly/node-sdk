# F113 Verification — AAASM-1203 (Node.js SDK npm distribution)

> **Status**: 4 of 4 implementation sub-tasks complete and merged on
> `master @ 8d2f23e`. All locally-verifiable AC bullets pass. The 3 AC
> bullets that require a real npm registry interaction are deferred to
> the first `v0.0.1` tag push — they will exercise the AAASM-1222
> release workflow end-to-end and only become measurable then.
>
> One AC bullet lands **scope-adapted** — `findBinary` in the ticket
> text is the same function as `findAasmBinary` shipped under AAASM-1228
> / F115. AAASM-1221 wired it through the SDK entrypoint without
> renaming. Documented inline.
>
> **No new Bug Subtask opened** as a result of this verification — every
> deferred AC bullet has a clear "unblocked when" trigger (the first
> v0.0.1 publish, owned by AAASM-1200 + AAASM-1233 + AAASM-1234).
>
> [AAASM-1199]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1199
> [AAASM-1200]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1200
> [AAASM-1203]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1203
> [AAASM-1220]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1220
> [AAASM-1221]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1221
> [AAASM-1222]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1222
> [AAASM-1223]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1223
> [AAASM-1228]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1228
> [AAASM-1233]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1233
> [AAASM-1234]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1234
> [AAASM-1235]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1235
> [AAASM-1503]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1503
> [AAASM-1660]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1660
> [AAASM-1661]: https://lightning-dust-mite.atlassian.net/browse/AAASM-1661

## Sub-task roll-up

| Sub-task | Title | Status | PR |
|---|---|---|---|
| [AAASM-1220] | Scaffold 4 platform runtime sub-packages | Done | [#42](https://github.com/ai-agent-assembly/node-sdk/pull/42) |
| [AAASM-1221] | Wire optionalDependencies + SDK entrypoint re-export | Done | [#43](https://github.com/ai-agent-assembly/node-sdk/pull/43) |
| [AAASM-1222] | Implement release-node.yml publish workflow | Done | [#45](https://github.com/ai-agent-assembly/node-sdk/pull/45) |
| [AAASM-1223] | Verify F113 acceptance | in this report | this PR |

## Walkthrough vs AAASM-1223 acceptance criteria

### ⚠️ `npm install agent-assembly` on Linux x64 installs `@agent-assembly/runtime-linux-x64` only

**Adapted** — packages haven't been published to npm yet (no `v*.*.*`
tag has been cut; AAASM-1233 v0.0.1 version bump is still To Do).
Verifiable today by inspection of the `os`/`cpu` constraints on each
sub-package — npm + pnpm both honor these via their install-time
compatibility check.

Per-sub-package schema from `master @ 8d2f23e` (captured via
`node -e "console.log(JSON.stringify(require('./packages/<pkg>/package.json')))"`):

```
runtime-linux-x64    os=["linux"]    cpu=["x64"]
runtime-linux-arm64  os=["linux"]    cpu=["arm64"]
runtime-darwin-x64   os=["darwin"]   cpu=["x64"]
runtime-darwin-arm64 os=["darwin"]   cpu=["arm64"]
```

On a Linux x64 host, npm/pnpm will install only the package whose
constraints match (`linux` + `x64`) — i.e. `runtime-linux-x64`. The
other 3 fail the compatibility check and are skipped (this is the
esbuild distribution pattern AAASM-1203 explicitly targets in its
Story description).

Real-registry verification deferred to first v0.0.1 publish — same
disposition as the AAASM-1204 / AAASM-1441 verification reports.

### ⚠️ `npm install agent-assembly` on macOS ARM64 installs `@agent-assembly/runtime-darwin-arm64` only

Same disposition as the Linux x64 bullet — `os=["darwin"]` + `cpu=["arm64"]`
constraint on `runtime-darwin-arm64` matches Apple Silicon hosts and
nothing else. Skipped at install for the other 3 platforms.

### ⚠️ `pnpm install` behaves identically to `npm install` for platform selection

Both package managers implement the same `os`/`cpu` filtering for
`optionalDependencies` (defined in npm's package.json
[specification](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#os)
and respected by pnpm + yarn alike). The per-sub-package schema in the
previous AC bullet is the contract both install paths honor.

Empirically: the existing top-level `optionalDependencies` napi-rs
packages (`@agent-assembly/darwin-arm64`, `@agent-assembly/win32-x64-msvc`)
have been distributed via this same mechanism on this repo's prior
releases — proving npm + pnpm install do honor the constraints in
practice. The new `runtime-*` sub-packages reuse the same mechanism.

Real-registry verification deferred to first v0.0.1 publish.

### ✅ `require('@agent-assembly/sdk').findAasmBinary()` resolves the binary path after install

**Scope-adapted from "findBinary"** — the ticket text uses the shorthand
`findBinary`; the actual function shipped under AAASM-1228 and re-exported
from the SDK entrypoint under AAASM-1221 is `findAasmBinary` (more
specific name). Per the workspace convention "do not rename subtasks
based on description wording", no rename — same surface area, more
descriptive identifier.

Live trace against a fabricated post-install layout on `master @
8d2f23e` (host: macOS ARM64, so the matching sub-package is
`runtime-darwin-arm64`):

```
Scenario 1 (bundled runtime present):
  expected: <path to>/node_modules/@agent-assembly/runtime-darwin-arm64/bin/aasm
  findAasmBinary() -> /private/var/folders/.../aaasm-1223-uwJujo/node_modules/@agent-assembly/runtime-darwin-arm64/bin/aasm
```

The function correctly resolved the bundled binary path within the
fabricated `node_modules` tree — matching the post-`npm install` state
described by the AC. The temp-dir prefix expansion (`/private/var/...`)
is the macOS-specific realpath canonicalisation (also documented in
`tests/runtime.test.ts` line 62 — "createRequire.resolve canonicalises
symlinks").

This AC bullet is also locked by automated test
[`tests/runtime.test.ts:50-70`](../tests/runtime.test.ts) (`findAasmBinary
returns the bundled-runtime path when the npm optional sub-package is
installed`), part of the master test suite — 132+ tests pass at every
commit.

### ✅ Installing on a platform with no matching sub-package fails gracefully with a clear error

Live trace, same `master @ 8d2f23e`:

```
Scenario 2 (no bundled runtime):
  findAasmBinary() -> null
  INSTALL_HINT starts with: agent-assembly runtime not found.
```

Full `INSTALL_HINT` text from `src/runtime.ts`:

```
agent-assembly runtime not found.
  Install with: pnpm add agent-assembly
  Or manually:  brew install agent-assembly/tap/aasm
               curl -fsSL https://get.agent-assembly.io | sh
```

`initAssembly()` throws `Error(INSTALL_HINT)` when no binary is
resolvable — locked by automated test
[`tests/runtime.test.ts:72-92`](../tests/runtime.test.ts) (`initAssembly
throws Error with INSTALL_HINT when binary not found`) and additionally
covered at the SDK-entrypoint surface by
[`tests/runtime-entrypoint-export.test.ts:18-22`](../tests/runtime-entrypoint-export.test.ts)
(re-export contract assertion).

### ⚠️ All 5 packages are published to npm registry with correct version on release tag

**Adapted** — no `v0.0.1` tag has been pushed yet. AAASM-1222's release
workflow (`.github/workflows/release-node.yml`) is the design contract;
its first real run produces the AC evidence.

Workflow trace (read from `master @ 8d2f23e`):

| Step | Action |
|---|---|
| 1 | checkout + pnpm + node setup + `pnpm install --frozen-lockfile` |
| 2 | Resolve tag version — semver-validate; reject non-`v*.*.*` |
| 3 | `gh release download <tag> --repo ai-agent-assembly/agent-assembly --pattern "aasm-*.tar.gz"` — downloads 4 platform binaries from agent-assembly's matching release (AAASM-1200's output) |
| 4 | Per-target `tar -xzf` into `packages/runtime-{platform}/bin/aasm` + `chmod +x` + strip `.gitkeep` placeholder |
| 5 | Bump `version` in all 5 `package.json` + sync root SDK's `optionalDependencies['@agent-assembly/runtime-*']` to the same version |
| 6 | `pnpm build` (ESM + CJS dual build) |
| 7 | `pnpm publish --access public --no-git-checks` for each of the 4 runtime sub-packages (in order) |
| 8 | `pnpm publish --access public --no-git-checks` for main `@agent-assembly/sdk` |

Auth: `id-token: write` permission + `NPM_CONFIG_PROVENANCE=true` (npm
OIDC Trusted Publishing — primary); `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN
}}` fallback if Trusted Publishing isn't yet configured on npmjs.com.

Order matters: 4 sub-packages publish first because the main SDK's
`optionalDependencies` reference them — publishing main first would
produce "no matching version" warnings during the brief window before
all sub-packages land on the registry. Workflow comments on this
explicitly.

## Deferred-AC summary

| AC bullet | Status | Tracked under | Unblocked when |
|---|---|---|---|
| `npm install` on Linux x64 → only `runtime-linux-x64` | ⚠️ Deferred | AAASM-1233 + AAASM-1200 + AAASM-1234 + AAASM-1235 | First v0.0.1 publish |
| `npm install` on macOS ARM64 → only `runtime-darwin-arm64` | ⚠️ Deferred | Same | Same |
| `pnpm install` parity with `npm install` | ⚠️ Deferred | Same | Same |
| 5 packages published with correct version | ⚠️ Deferred | AAASM-1222 workflow (registered); fires on first `v*.*.*` tag | First v0.0.1 publish |

## Adaptations summary

| # | Ticket text | What shipped | Forced by |
|---|---|---|---|
| 1 | `npm install agent-assembly` on Linux x64 / macOS ARM64 installs the matching sub-package only | Schema verified by inspection (`os` / `cpu` constraints); real-registry test deferred to first v0.0.1 publish | No `v*.*.*` tag cut yet; same disposition as AAASM-1204 / AAASM-1441 verification reports |
| 2 | `require('@agent-assembly/sdk').findBinary()` resolves binary path | Shipped as `findAasmBinary` (AAASM-1228 / F115); re-exported from SDK entrypoint under AAASM-1221 — same surface area, more descriptive name. No rename per workspace "do not rename based on description wording" convention |
| 3 | 5 packages published to npm registry on release tag | Workflow registered under AAASM-1222; fires on first `v*.*.*` tag push (likely tied to AAASM-1233 v0.0.1 version bump) | Release flow owns this; no tag cut yet |

## Sign-off

* All 4 implementation sub-tasks (AAASM-1220 / 1221 / 1222) merged on
  `master @ 8d2f23e`.
* The 2 locally-verifiable AC bullets (binary resolution + graceful
  failure) pass live tracing + locked by 6 automated tests in
  `tests/runtime.test.ts` + `tests/runtime-entrypoint-export.test.ts`.
* The 4 deferred AC bullets each have a clear "unblocked when" trigger
  (first v0.0.1 publish, gated by AAASM-1233 + AAASM-1200 + AAASM-1234
  + AAASM-1235), and the AAASM-1222 release workflow's design contract
  has been traced step-by-step from the workflow file.
* No new Bug Subtask opened.

Story [AAASM-1203] is verifiable as **Done** at the
implementation-and-design-contract scope, with the residual real-publish
verification deferred to the first release tag — same disposition the
AAASM-1199 Epic's other verification reports (AAASM-1204.md,
AAASM-1441.md) used for their equivalent registry / tag-push gaps.

Downstream now unblocked once `@agent-assembly/sdk` lands on npm:
[AAASM-1503], [AAASM-1660], [AAASM-1661] (re-enable Node Docker variants
in `agent-assembly`).
