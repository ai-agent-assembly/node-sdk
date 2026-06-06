# Verification — AAASM-2560 (Thin Node napi shim over `aa-sdk-client`)

> **Status**: implementation (AAASM-2643, PR [#82]) complete; all acceptance
> criteria pass locally. This is Story 7 of the SDK-security-boundary Epic
> ([AAASM-2552]). The runtime-enforcement gate ([AAASM-2568]), `aa-security`
> extraction ([AAASM-2567]), and `aa-sdk-client` extraction ([AAASM-2570]) are
> all merged, so the boundary-first invariant holds: SDK-side scanning is only
> retired now that the runtime is authoritative.
>
> **No new Bug Subtask** opened by this verification.
>
> [AAASM-2552]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2552
> [AAASM-2560]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2560
> [AAASM-2643]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2643
> [AAASM-2644]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2644
> [AAASM-2559]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2559
> [AAASM-2567]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2567
> [AAASM-2568]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2568
> [AAASM-2570]: https://lightning-dust-mite.atlassian.net/browse/AAASM-2570
> [#82]: https://github.com/AI-agent-assembly/node-sdk/pull/82

## Sub-task roll-up

| Sub-task | Title | Status | PR |
|---|---|---|---|
| [AAASM-2643] | Rewrite `aa-ffi-node` as thin napi shim over `aa-sdk-client` | Done (PR open) | [#82] |
| [AAASM-2644] | Verify thin Node napi shim acceptance criteria | in this report | this PR |

## Acceptance criteria

### ✅ AC1 — Node binding is a thin shim over `aa-sdk-client`; `pnpm native:build` + `pnpm test` green

* `native/aa-ffi-node/Cargo.toml` depends on `aa-sdk-client` (git-SHA pin
  `9cf8a033`); `src/lib.rs` imports `aa_sdk_client::{AssemblyClient,
  AssemblyConfig}` + `aa_sdk_client::ipc::spawn_ipc_thread` and is 107 lines,
  the bulk of which is documentation.
* `connect` → `AssemblyConfig::resolve_socket_path` + `spawn_ipc_thread` +
  `AssemblyClient::new`; `sendEvent` → `AssemblyClient::report_event`;
  `disconnect` → `AssemblyClient::shutdown` (on a blocking task).

```
$ pnpm native:build
   Compiling aa-security … aa-proto … aa-sdk-client … aa-ffi-node
    Finished `dev` profile [unoptimized + debuginfo] target(s)

$ pnpm test
 Test Files  38 passed | 1 skipped (39)
      Tests  179 passed | 2 skipped (181)

$ AA_NATIVE_TEST=1 pnpm vitest run tests/native-napi-integration.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)          # against the real index.node, over a UDS

$ pnpm typecheck   # ✅   $ pnpm lint   # ✅
```

### ✅ AC2 — No `aa_*`-free reimplementation remains; the shim holds no authoritative security logic

* The binding now imports `aa_sdk_client` (previously it imported **zero**
  `aa_*` crates). `grep -niE "scan|redact|query_policy|policyresult|mpsc|unbounded"
  src/lib.rs` returns only documentation lines — no scanner, no redactor, no
  in-process IPC pump, no synthesized policy decision.
* The fake `query_policy` (which read `denied`/`pending`/`reason` straight off
  the caller's action JSON) is **removed** from the binding. `set_event_listener`
  and `socket_path` (unused by the TS layer) are removed too.
* No `clean` / `already_scanned` wire marker exists or is emitted. Any redaction
  is **advisory only**, performed inside `aa-sdk-client`'s `preflight` feature;
  the runtime (AAASM-2568) re-scans every event unconditionally.

### ✅ AC3 — Behavior matches the shared client (no per-language drift)

* Transport, IPC wire codec, `AssemblyClient` lifecycle, and advisory preflight
  all live in `aa-sdk-client` — the single implementation also consumed by the
  Python shim (AAASM-2561). The Node shim only translates the JS event object to
  the shared `(event_type, details)` shape and forwards it.
* The integration test drives the **real** `index.node` against a codec-speaking
  mock `aa-runtime` UDS endpoint and asserts every event is delivered over the
  socket — exercising the shared transport, not a node-only stub.

## Notes / deliberate changes

* **Backpressure semantics changed (intended).** The old node-only binding used
  an *unbounded* in-memory channel, so `sendEvent` never applied backpressure.
  The shared client uses a bounded channel with `blocking_send`. The integration
  test was updated to assert real end-to-end delivery under normal load instead
  of the old unbounded-throughput property — that property *was* part of the
  per-language drift this Epic eliminates. A future async/non-blocking
  `report_event` (if desired for Node) belongs in `aa-sdk-client`, not in a
  per-language shim.
* **CI**: `build-addon.yml` gains a protoc setup step because the binding now
  pulls `aa-proto` transitively (its build script compiles `.proto` with protoc).
* **Distribution**: `aa-sdk-client` is consumed via a git-SHA pin, mirroring the
  python-sdk precedent (`aa-core`/`aa-proto`). [AAASM-2559] will formalize a
  published/pinned distribution + a standalone-build CI smoke check; it does not
  block this consumption today.
* **Public API unchanged**: only the internal napi binding surface changed. The
  exported `@agent-assembly/sdk` TypeScript API (`initAssembly`, `withAssembly`,
  `NativeClient`) is untouched; `NativeClient.queryPolicy` is retained as a
  non-authoritative neutral deferral.
