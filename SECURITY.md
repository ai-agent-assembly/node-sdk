# Security Policy

## Reporting a vulnerability

Please do **not** file a public issue for a security vulnerability. Report it
privately via the repository's
[security advisories](https://github.com/ai-agent-assembly/node-sdk/security/advisories)
page so a fix can be coordinated before disclosure.

## Canonical package names

The Node SDK is published to npm **only** under the `@agent-assembly` scope. The
canonical packages are:

| Package | Role |
|---|---|
| `@agent-assembly/sdk` | The SDK itself (the package you install). |
| `@agent-assembly/runtime-linux-x64` | Bundled `aasm` runtime binary, optional dependency. |
| `@agent-assembly/runtime-linux-arm64` | Bundled `aasm` runtime binary, optional dependency. |
| `@agent-assembly/runtime-darwin-x64` | Bundled `aasm` runtime binary, optional dependency. |
| `@agent-assembly/runtime-darwin-arm64` | Bundled `aasm` runtime binary, optional dependency. |

The four `runtime-*` packages are pulled in automatically as
`optionalDependencies` of `@agent-assembly/sdk`; you never install them directly.

**Anything outside this list is not us.** Unscoped names (e.g. `agent-assembly`),
look-alike scopes, or near-miss spellings are typosquats — do not install them.

## Verifying what you installed

Every release is published through an operator-gated, OIDC-authenticated pipeline
(`release-node.yml`) and ships two consumer-verifiable integrity signals.

### 1. npm provenance (SLSA)

Each package is published with `--provenance`, so npm records a signed,
tamper-evident link back to the exact GitHub Actions run and source commit that
built it. Verify it:

```bash
# Verify the registry signatures + provenance attestations of your install tree.
npm audit signatures
```

You can also see the **Provenance** panel on the package page at
<https://www.npmjs.com/package/@agent-assembly/sdk>. A package built outside the
sanctioned pipeline carries no provenance — its absence is the tell.

### 2. CycloneDX SBOM

Each GitHub Release attaches a CycloneDX Software Bill of Materials,
`sbom.cdx.json`, listing the exact dependency set that release was built against.
Download it from the matching release on the
[Releases page](https://github.com/ai-agent-assembly/node-sdk/releases) and
cross-check it against your installed tree and your advisory feed of choice.

## CI advisory gate

Dependencies are scanned on every PR and push by the `dependency-audit` workflow
(`pnpm audit --audit-level=high`); a known-vuln dependency fails CI and blocks the
release. Advisories with no available fix are allowlisted, with a dated rationale,
in the root `package.json` under `pnpm.auditConfig`.
