# CLAUDE.md — node-sdk

Guidance for Claude Code (and humans) working in this repository. This file holds
**repo-specific** context only; universal engineering policy lives in the global
config. When a fact here duplicates `CONTRIBUTING.md`, `package.json`, or the CI
workflows, treat those as the source of truth and update them, not just this file.

## What this repo is

The **TypeScript SDK** for AI Agent Assembly, published as **`@agent-assembly/sdk`**.
It has two layers: a TypeScript client (`src/`) and an embedded Rust **napi-rs native
binding** under `native/aa-ffi-node/` — a thin shim over the **`aa-sdk-client`** crate
**pinned by git SHA** from the `ai-agent-assembly/agent-assembly` monorepo (see
`native/aa-ffi-node/Cargo.toml`). The monorepo is the source of truth for the protocol,
policy semantics, and the shared `aa-*` crates; this repo only consumes them.

In the product's **three-layer interception model**, this SDK is the **SDK layer
(in-process)** — the fastest, lowest-latency path. It emits events to the gateway and
applies pre-execution allow/deny through framework wrappers, but requires SDK adoption.
The other two layers (sidecar `aa-proxy`, kernel `aa-ebpf*`) live in the monorepo and
catch anything the SDK misses. The SDK is **not** the authoritative enforcement point —
`aa-runtime` in the monorepo is.

## Source layout

- `src/` — TypeScript client: `index.ts` (public entrypoints `initAssembly`,
  `withAssembly`), `core/init-assembly.ts` (lifecycle), `adapters/` (framework
  integrations, e.g. `langchain/`), `gateway/`, `hooks/`, `wrappers/`, `errors/`,
  `types/`, and `native/` (binding to the native module).
- `native/aa-ffi-node/` — the napi-rs Rust crate; generated `index.cjs` / `index.d.ts`
  are **checked in** (tracked artifacts) and ESLint-ignored.
- `tests/` — vitest suites. `docs/` — long-form Markdown. `website/` — Docusaurus app
  (kept separate from `docs/`, see gotchas).

## Build, test, lint

Node ≥ 18.18, pnpm ≥ 10. See `CONTRIBUTING.md` for the full list. Common commands:

```bash
pnpm install                  # installs deps + runs scripts/postinstall.mjs (native wiring)
pnpm test                     # vitest run (full suite)
pnpm test -- src/adapters     # filter by directory
pnpm test -- -t "deferred"    # filter by test name
pnpm test:coverage            # vitest with lcov + text reporter
pnpm build                    # ESM (dist/esm/) + CJS (dist/cjs/) via two tsc passes
pnpm typecheck                # tsc --noEmit against tsconfig.test.json
pnpm lint                     # eslint .
pnpm native:build             # napi-rs debug build of the native binding
pnpm native:build:release     # napi-rs release build (per-platform artifact)
```

- TypeScript is **strict** + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`;
  no `any` without an inline justification.
- Most TS work does not need the native build to pass — the native integration test
  only runs with `AA_NATIVE_TEST=1`.
- After `pnpm native:build`, commit any changes to the tracked `index.cjs` / `index.d.ts`.

## Conventions (see `CONTRIBUTING.md` — don't duplicate)

- **Commits:** `<emoji> (<scope>): <imperative summary>` (gitmoji.dev). One logical
  unit per commit; bisectable. Utils/mocks/tests are separate preceding commits.
- **Branch:** `<release-or-phase>/<ticket>/<type>/<short_summary>`
  (e.g. `v0.0.1/AAASM-42/feat/add_langchain_adapter`).
- **PR title:** `[<ticket>] <emoji> (<scope>): <summary>`; base branch **always
  `master`**; body fills out `.github/PULL_REQUEST_TEMPLATE.md`; ≥1 Pioneer-team
  approval.

## Repo-specific gotchas

- **Standalone Docusaurus `website/`** is a *separate* pnpm project from the SDK. Run
  `cd website && pnpm install --ignore-workspace` — without `--ignore-workspace` it
  resolves against the root workspace and its dependency `overrides` silently don't
  apply (this matters for security pins). Docs content lives in `docs/`; the app
  (config/theme/sidebars) lives in `website/`, intentionally split.
- **Push remote is `remote`** (→ `ai-agent-assembly/node-sdk`, canonical), **not**
  `origin` (a personal fork). Detect it with `git remote -v`; scope changes against
  `remote/master`, which is often far ahead of a fork checkout. The "repository moved"
  redirect notice on push is harmless.
- **npm security fixes:** pin with a `^` floor or a precise version — **never a bare
  `>=`**. A bare `>=` lets the resolver pull an unwanted major and breaks the build.
- **napi-rs shim pins `aa-sdk-client` by git `rev`** in
  `native/aa-ffi-node/Cargo.toml`. Bumping it means re-pinning the monorepo SHA and
  rebuilding the native binding; the advisory (non-authoritative) preflight arrives
  transitively via that crate's default `preflight` feature.
- **LangChain two-layer enforcement:** `handleToolStart` cannot preempt by return value,
  and `@langchain/core` discards a callback handler's `handleToolEnd` return value too
  (confirmed in `@langchain/core/dist/tools/index.cjs`), so the callback layer is
  audit-only (records denials/results, never blocks or redacts output) and the wrapper
  layer (`wrapToolWithAssembly`, true pre-execution deny) is the only actual enforcement
  point. Changes to one require corresponding changes to the other — see the root
  `CLAUDE.md` and README for the full adapter footguns. (AAASM-4799)
- **Hooks:** pre-commit runs eslint/prettier/test-smoke; pre-push runs full test +
  typecheck. **Never `--no-verify`; never force-push.** If a hook fails in a fresh
  worktree because `node_modules` is missing (lint-staged/tsc ENOENT), fix it by
  symlinking the main checkout's `node_modules` — don't bypass.

## Project policy

- **JIRA:** project AAASM; set the native **Component** field (not
  `customfield_10041`, which is null) to `ai-agent-assembly/node-sdk`;
  Team (`customfield_10001`) = Pioneer. Epic → Story →
  Subtask (one Subtask ≈ one commit) + a `Verify …` subtask per Story.
- **Self-hosted deployment is out of scope** product-wide — don't propose
  Helm/Terraform/air-gapped/migration work even if the spec mentions it.
- **The Protocol Specification stays in the `agent-assembly` monorepo** — do not move
  spec work to a separate `agent-assembly-spec` repo (that repo is archived by design).

## Documentation conventions — document the WHY, not the WHAT

Comments and docstrings exist to capture intent that the code cannot: rationale,
constraints, invariants, and non-obvious decisions. Restating what the code already
says is noise that rots out of sync — avoid it.

- **Module headers (top-of-file TSDoc/`//` block):** yes — the module's role, key
  invariants, and where it sits in the three-layer model (e.g. why a wrapper enforces
  pre-execution while a callback can only observe/audit post-execution).
- **Exported / public API (TSDoc `/** */` on `export`ed fn/class/interface/type):**
  yes — the contract: behavior, thrown errors, units, side effects, and any
  async/ordering/`@throws` constraints. Especially the surprising ones (e.g. "matches
  by description, not name, for Vercel AI tools", "fail-closed when the gateway is
  unreachable").
- **Inline `//` why-comments:** for workarounds, security rationale, and dependency
  pins — the `aa-sdk-client` git-SHA pin comment in `Cargo.toml` is the gold standard
  (it explains *why* it's pinned, not just that it is). The same applies to `any`
  escape hatches and lint suppressions.
- **Skip:** trivial private helpers, getters, type-restating, and anything a reader
  infers from the signature. No per-parameter docstrings that echo the types.
- **Big architectural decisions → ADRs**, not scattered docstrings; link code to the
  ADR. Design notes already live in `docs/` — reference them.

> Net: a new contributor (human or LLM) should be able to read a module's header and an
> exported item's TSDoc and understand *why it is the way it is* without reverse-
> engineering it. If a comment only says *what*, delete it.
