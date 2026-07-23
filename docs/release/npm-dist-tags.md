# npm dist-tag policy — `@agent-assembly/sdk`

This package publishes to npm via [`.github/workflows/release-node.yml`](https://github.com/ai-agent-assembly/node-sdk/blob/main/.github/workflows/release-node.yml).
Each release is routed to a **channel** dist-tag derived from its SemVer
pre-release identifier, and the floating `latest` tag is kept current
automatically.

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

## `latest` policy (pre-1.0 / pre-GA)

While the project is pre-1.0 and has shipped only pre-releases, `latest` always
points at the **highest SemVer version currently on npm, across every channel**.

SemVer precedence (`alpha < beta < rc < GA`) makes this rule self-correcting and
monotonic:

- A GA publish wins over any pre-release of the same base, so `latest` naturally
  tracks the newest GA once one exists.
- While only pre-releases exist, `latest` tracks the newest pre-release
  (e.g. `rc.2` over `beta.5` over `alpha.9.1`) — never the oldest.
- It never regresses `latest` to an older build, even if a hotfix to an older
  channel is published after a newer one.

The release workflow re-asserts this invariant on every real (non-dry-run)
publish, in both `all` and `main-only` publish modes.

## One-time manual correction

The workflow only advances `latest` on the **next** publish. If `latest` is
currently stale (the bug tracked in AAASM-3840 left it pinned at
`0.0.1-alpha.3`), a package owner with an npm publish token must run the
correction once, out of band:

```bash
# Replace <newest> with the highest version currently on npm
# (e.g. the current rc), then:
npm dist-tag add @agent-assembly/sdk@<newest> latest
```

After that one-time fix, the workflow keeps `latest` current going forward.

See the canonical docs at https://docs.agent-assembly.com for end-user install
guidance.
