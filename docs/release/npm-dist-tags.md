# npm dist-tag policy — `@agent-assembly/sdk` and its 4 runtime sub-packages

This package (and its 4 `@agent-assembly/runtime-{linux,darwin}-{x64,arm64}`
sub-packages, published in lockstep) publish to npm via
[`.github/workflows/release-node.yml`](https://github.com/ai-agent-assembly/node-sdk/blob/main/.github/workflows/release-node.yml).
Each release is routed to a **channel** dist-tag derived from its SemVer
pre-release identifier, and the floating `latest` tag is kept current
automatically for all 5 packages (AAASM-4994).

## Channel dist-tags

The publish steps derive the channel tag from the version's pre-release
identifier:

| Version example       | dist-tag           |
| --------------------- | ------------------ |
| `0.0.1-alpha.9.1`     | `alpha`            |
| `0.0.1-beta.5`        | `beta`             |
| `0.0.1-rc.2`          | `rc`               |
| `0.1.0` (bare `X.Y.Z`) | `latest` (implicit) |

Install a specific channel with, e.g., `npm install @agent-assembly/sdk@rc`.

## `latest` policy (pre-1.0 / pre-GA) — durable decision, not a stopgap

While the project is pre-1.0 and has shipped only pre-releases, `latest` always
points at the **highest SemVer version currently on npm, across every channel**,
for all 5 packages.

This is a **deliberate, considered decision** — not the "standard" convention
of "an RC publish never touches `latest`, only a GA publish does." That
standard convention was evaluated and rejected for this project *while it has
never shipped a GA*: there is no stable line for `latest` to anchor to, so
freezing `latest` at whatever predates the first pre-release would revive the
exact bug this policy exists to prevent (`npm install @agent-assembly/sdk`
resolving to an ancient alpha — AAASM-3840/4730/4994, three recurrences).
**Once a GA `X.Y.Z` version is published, this policy converges naturally to
the standard convention** (see below) — no code change is needed for that
transition, only a decision that no *earlier* code change should force it.

SemVer precedence (`alpha < beta < rc < GA`) makes this rule self-correcting
and monotonic:

- A GA publish wins over any pre-release of the same base, so `latest` naturally
  tracks the newest GA once one exists, and from that point on an RC publish
  never moves `latest` past a GA that already precedes it in the published
  history — the policy is already forward-compatible with GA without
  modification.
- While only pre-releases exist, `latest` tracks the newest pre-release
  (e.g. `rc.2` over `beta.5` over `alpha.9.1`) — never the oldest.
- It never regresses `latest` to an older build, even if a hotfix to an older
  channel is published after a newer one.

The release workflow re-asserts this invariant on every real (non-dry-run)
publish, in both `all` and `main-only` publish modes, for `@agent-assembly/sdk`
always and the 4 `runtime-*` sub-packages whenever `publish_mode=all` (they are
only published in that mode).

## Trusted Publishing (OIDC) vs. the `latest` dist-tag mutation — do not conflate

`npm publish` itself is fully OIDC Trusted Publishing (AAASM-4017): the publish
job runs on a GitHub-hosted `ubuntu-latest` runner, under a protected `npm`
GitHub Environment, with `permissions: id-token: write` and no
`NODE_AUTH_TOKEN` on either publish step — package *contents* ship with **zero**
long-lived credential.

**`npm dist-tag add` (the `latest`-repair step) is a separate, non-publish
registry write that npm OIDC does not cover** (upstream `npm/cli#8547`,
tracked, not this repo's gap) and therefore still requires `NPM_TOKEN`. Do not
claim or assume OIDC covers this operation — it does not, and treating it as
if it did is how this policy's own automation goes silently stale.

## Known recurring failure mode and its durable fix (AAASM-3840 → 4730 → 4994)

This exact defect — `latest` stuck on an old version — recurred three release
cycles running, for two *different* reasons across the two most recent
occurrences:

1. **rc.6 occurrence (AAASM-4730):** a registry read-consistency race —
   fixed in code (seed the newest-version computation with the just-published
   version rather than trusting an immediate registry read-back).
2. **rc.7 occurrence (AAASM-4994):** `NPM_TOKEN` was invalid/expired, and once
   rotated with a fresh, *valid* token, `npm dist-tag add` still failed with
   `EOTP` — npm requires an interactive one-time password for this operation
   unless the token is an npm **Automation**-type access token (exempt from
   the 2FA-on-write prompt by npm's own design for unattended CI). A classic
   Read-and-Publish token is not sufficient, valid or not.

**The durable fix is the token type, not the step's logic:** `NPM_TOKEN`
should be an npm Automation access token scoped to `@agent-assembly/*`, so
this step runs unattended on every release without any manual OTP step ever
again. This is the concrete form of what AAASM-4017's own closure comment
already anticipated ("a granular automation token").

Separately, this step previously covered only `@agent-assembly/sdk` — the 4
`runtime-*` sub-packages' `latest` was never advanced by any automation and
silently drifted to `0.0.1-alpha.4` while `sdk` moved through rc.5/rc.6/rc.7.
Low real-world impact (the sub-packages are consumed by exact-version
`optionalDependencies` from the main package, not by their own `latest`), but
genuinely inconsistent. Fixed in the workflow (loops over all 5 packages now)
and manually corrected on the live registry during the rc.7 campaign.

## Future GA transition

No workflow change is required when the project ships its first GA `X.Y.Z`:
a bare `npm publish` (no `--tag`) implicitly sets `latest`, and the existing
semver-max `latest`-repair step (which already runs on every publish) will
correctly leave `latest` on the GA once it is the highest published version —
it never needs to special-case "is this a GA publish."

See the canonical docs at https://docs.agent-assembly.com for end-user install
guidance.
