# Contributing to @agent-assembly/sdk

Thank you for considering a contribution! This guide explains how to set up your local
environment and start hacking on the Node.js SDK for Agent Assembly.

## Development environment setup

### Prerequisites

- Node.js ≥ 18.18.0 (LTS)
- pnpm ≥ 10
- Git
- Rust toolchain (only required when rebuilding the native `aa-ffi-node` binding)

### Clone and install

```bash
git clone https://github.com/ai-agent-assembly/node-sdk.git
cd node-sdk
pnpm install
pnpm build
```

`pnpm install` runs `scripts/postinstall.mjs` to wire in the prebuilt native binding for
your platform. `pnpm build` produces both ESM (`dist/esm/`) and CJS (`dist/cjs/`) outputs
from a single TypeScript source.

If you intend to modify the native Rust crate (`native/aa-ffi-node/`), rebuild it with:

```bash
pnpm native:build               # debug build, local
pnpm native:build:release       # release build, per-platform artifact
pnpm native:check-types         # validate generated index.d.ts
```

## Adding a framework adapter

Framework adapters are the integration points between Agent Assembly and a third-party
agent framework (LangChain, OpenAI Agents, Vercel AI SDK, etc.). Each adapter implements
the `Adapter` interface in `src/adapters/adapter.ts`:

```ts
export interface Adapter {
  readonly id: string;
  apply: () => Promise<void>;
  shutdown?: () => Promise<void>;
}
```

To add a new adapter for `<framework>`:

1. **Create a new directory** under `src/adapters/<framework>/` for the integration's
   surface area (callback handlers, wrappers, type bridges).
2. **Implement the `Adapter` interface** — `apply()` performs framework-specific
   registration; `shutdown()` (optional) cleans up subscriptions or globals.
3. **Register the adapter** with the `AdapterRegistry` from `init-assembly.ts`. The
   registry is constructed during `initAssembly()` and `applyAll()` is invoked on every
   registered adapter.
4. **Add types** — public types belong in `src/types/`; framework-private types stay
   inside the adapter directory.
5. **Write tests** under `tests/adapters/<framework>/` covering both the wrapper layer
   (pre-execution checks) and any callback layer (post-execution redaction).

Refer to `src/adapters/langchain/` for a reference implementation that demonstrates the
two-layer enforcement model required when a framework's hook surface cannot preempt
execution.

## Running tests and type checks

```bash
pnpm test                       # vitest run, full suite
pnpm test -- src/adapters       # filter by directory
pnpm test -- -t "deferred"      # filter by test name
pnpm test:coverage              # vitest with lcov + text reporter
pnpm typecheck                  # tsc --noEmit against tsconfig.test.json
```

The native integration test only runs when `AA_NATIVE_TEST=1` is set:

```bash
AA_NATIVE_TEST=1 pnpm vitest run tests/native-napi-integration.test.ts
```

### TypeScript strict mode

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, and
`exactOptionalPropertyTypes`. Contributions must compile cleanly under these flags:

- No `any` without an inline comment justifying the escape hatch.
- Index access (`array[i]`, `record[key]`) returns `T | undefined` — handle the
  `undefined` case explicitly.
- Optional properties must be either present with a value or absent; do not assign
  `undefined` to satisfy the type system.

Run `pnpm typecheck` before pushing — CI rejects any type error.

## Linting and formatting

The repository uses **ESLint flat config** (`eslint.config.mjs`) layered on
`@eslint/js` recommended rules and `typescript-eslint`'s recommended rules, plus a
type-aware project pass over `tsconfig.build.json` and `tsconfig.test.json`.

```bash
pnpm lint                       # eslint .
pnpm format                     # prettier --write .
```

Notes:

- Generated artifacts (`dist/`, `coverage/`, `native/**/target/`) and the napi-rs
  generated files (`native/aa-ffi-node/index.cjs`, `native/aa-ffi-node/index.d.ts`)
  are excluded from linting.
- Prettier formats with `printWidth: 100`, `semi: true`, `singleQuote: false`,
  `trailingComma: "none"` (see `.prettierrc`).
- Do not suppress lint warnings without a comment explaining the exception.

## Pull request checklist

Before opening a PR, confirm each item:

- [ ] Branch follows `<release>/<ticket>/<type>/<short-summary>` naming.
- [ ] Each commit is atomic and uses GitEmoji-prefixed messages
      (`<emoji> (<scope>): <imperative summary>`).
- [ ] `pnpm lint` is clean.
- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm test` passes locally.
- [ ] New behaviour has tests; bug fixes include a regression test.
- [ ] Public API changes are reflected in `src/index.ts` exports and types.
- [ ] PR title format: `[<ticket>] <emoji> (<scope>): <summary>`.
- [ ] PR body fills out `.github/PULL_REQUEST_TEMPLATE.md` (target, ticket links,
      effecting scope, description).
- [ ] Base branch is `master`. Push remote is `remote` (not `origin`).
- [ ] At least one Pioneer team approval before merge.

## Building the documentation site

Long-form docs are delivered as a Docusaurus site. Markdown content lives in `docs/`
and the Docusaurus app (config, theme, sidebars) lives in `website/`. The two are
intentionally separated so consumers reading the GitHub repo see the content directly.

```bash
cd website
pnpm install                    # install Docusaurus deps (separate from the SDK's)
pnpm start                      # local dev server with hot reload
pnpm build                      # production build into website/build/
pnpm serve                      # preview the production build locally
```

The API reference under the **API** sidebar section is regenerated automatically by
`docusaurus-plugin-typedoc` from `src/index.ts` on every build — do not edit those
pages by hand.

When you push your branch, the `publish-docs.yml` workflow builds the site and
deploys to the `gh-pages` branch on push to `master`. The published site is at
**https://docs.agent-assembly.com/node-sdk/**.

## Shared docs metadata

Package name, version, install commands, npm dist-tag, and the docs URL used
across README.md and `docs/**` are generated from an authoritative source, not
maintained by hand. The pattern was introduced under AAASM-4312 (Epic AAASM-4309)
to prevent silent drift when the package is bumped or renamed.

**Sources of truth**

- `package.json` — package name, version, homepage, repository URL.
- `metadata/sdk.json` — docs URL, npm dist-tag, install-command templates,
  `aasm` CLI distribution commands. These are the values that do not naturally
  live in `package.json` but must stay in sync across documentation.

**Generator**

`scripts/generate-docs-metadata.mjs` reads both sources and rewrites the
bounded blocks in-place. It is pure Node, has zero network access, and is
idempotent — running it twice with the same inputs produces the same output.

```bash
pnpm run generate:docs-metadata
```

**Bounded block sentinels**

Generated content lives between sentinel comments so the surrounding prose is
untouched. The generator picks the sentinel dialect based on the file path:

- `README.md`, `CONTRIBUTING.md`, and any other GitHub-rendered Markdown use
  HTML comments:

  ```markdown
  <!-- BEGIN GENERATED: install-commands -->
  ...generated content — do not edit...
  <!-- END GENERATED: install-commands -->
  ```

- Files under `docs/` are MDX-parsed by Docusaurus and must use MDX expression
  comments — Docusaurus v3's MDX loader rejects bare `<!--`:

  ```mdx
  {/* BEGIN GENERATED: install-commands */}
  ...generated content — do not edit...
  {/* END GENERATED: install-commands */}
  ```

Available block ids: `install-commands`, `install-dist-tag`,
`package-identity`, `current-version-pin`.

**Source-code install hints**

The same generator also emits a small TypeScript module — `src/generated/install-hints.ts` — that runtime error sites import for install-command strings. Introduced under AAASM-4327 (Epic AAASM-4309) after a coverage audit found that `src/runtime.ts` and `src/core/gateway-resolver.ts` were still hardcoding `pnpm add @agent-assembly/sdk` and `npm install -g @agent-assembly/cli` — arguably worse than a stale docs page because it lands on a user actively trying to install.

The emitted module contains only `export const` declarations — no logic, no top-level `await` — so it compiles cleanly under both `tsconfig.build.json` (ESM) and `tsconfig.cjs.json` (CJS). It carries a `// GENERATED BY scripts/generate-docs-metadata.mjs — DO NOT EDIT.` header and is overwritten on every generator run; do not hand-edit it.

To route a new user-visible install command through the module:

1. Confirm the string can be derived from `package.json.name` or a field in `metadata/sdk.json`. If not, add the field in `metadata/sdk.json` first, following the workflow in the previous section.
2. Add a new `export const INSTALL_HINT_<NAME>` line to the emitter in `scripts/generate-docs-metadata.mjs` (inside `renderInstallHintsModule`). Keep the emitted body a plain double-quoted string literal — no template interpolation in the generated output.
3. Run `pnpm run generate:docs-metadata` and commit both the script and the regenerated `src/generated/install-hints.ts` together.
4. In the runtime source file, `import { INSTALL_HINT_<NAME> } from "…/generated/install-hints.js"` (Node ESM specifier for a `.ts` file compiles to `.js` at build time) and use it in place of the literal.

The `publish-docs.yml` workflow's drift check runs the generator and `git diff --exit-code` against `README.md`, `docs/`, and `src/generated/` — so a stale emitted module fails CI in the same way a stale docs page does.

**Adding a new shared value**

1. If the value lives in `package.json`, use it directly in the generator via
   the `loadMetadata()` helper. Otherwise, add the field to `metadata/sdk.json`
   with a short comment describing what depends on it.
2. Add a `render<Block>(meta, dialect)` function in
   `scripts/generate-docs-metadata.mjs` that returns the body of the new
   bounded block, and register it in the `BLOCKS` map at the top of the file.
   Use `dialect.header(id)` for the "GENERATED BY ..." line so the header
   matches the file's comment syntax.
3. Wrap the target snippet in the relevant `.md`/`.mdx` file(s) with matching
   sentinels — HTML for GitHub-rendered files, MDX for anything under `docs/`.
   The generator skips files that do not contain matching sentinels, so no
   further wiring is needed.
4. Run `pnpm run generate:docs-metadata` and commit both the script change and
   the rewritten Markdown files together.

**CI enforcement**

`publish-docs.yml` runs the generator on every PR that touches `docs/` or
`website/` and fails if `git diff --exit-code` reports drift in `README.md`
or `docs/`. Do not skip this check — regenerate locally and commit the result.

**Do not template**

Historical release notes, changelog entries, and version-specific example
provenance (e.g., "This example was written against `0.0.1-rc.3`") must stay
literal. Use bounded blocks only for values that describe the *current* state
of the package.
