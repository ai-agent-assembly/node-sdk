---
sidebar_position: 1
---

# Troubleshooting

## `No gateway found … and 'aasm' is not on PATH`

`initAssembly()` reached the local-default step of
[gateway resolution](../05-configuration/index.md): no `gatewayUrl`
was supplied, no `AAASM_GATEWAY_URL` was set, no `~/.aasm/config.yaml` entry was found, and
nothing answered at `http://localhost:7391`. It then tried to auto-start a gateway but
could not find the `aasm` binary.

Fix one of:

- Install the CLI so auto-start works: `npm install -g @agent-assembly/cli`.
- Point the SDK at an already-running gateway: set `AAASM_GATEWAY_URL`, or pass
  `gatewayUrl` explicitly, or add an `agent.gateway_url` entry to `~/.aasm/config.yaml`.

## `Auto-started gateway … did not become ready`

`aasm` was found and spawned, but `/healthz` did not return success within the timeout.
Check that the gateway can bind its port and start cleanly by running
`aasm start --mode local --foreground` yourself and reading its output, then retry.

## Native addon fails to load / `No native addon binary found`

The native napi-rs addon is loaded by `native/aa-ffi-node/index.cjs`, which expects an
`index.node` (or platform-suffixed `index.*.node`) to be present. This can be missing on a
platform with no prebuilt package — notably **Windows**, which has no
`@agent-assembly/runtime-*` prebuild.

Build it from source against a Rust toolchain:

```bash
pnpm native:build           # debug build, local
pnpm native:build:release   # release build, per-platform artifact
pnpm native:check-types     # validate the generated index.d.ts
```

If you do not need the in-process binding, run in `mode: "sdk-only"` (or
`"grpc-sidecar"`), which does not load the addon.

## `~/.aasm/config.yaml` seems to be ignored

The config file is parsed only when the optional `js-yaml` dependency is installed; a
missing `js-yaml`, a missing file, or malformed YAML is treated as "no value" (never an
error), so resolution silently falls through to the next step. Install `js-yaml` and
confirm the file is valid YAML with the expected `agent.gateway_url` / `agent.api_key`
shape shown in [Configuration](../05-configuration/index.md).

## `RangeError` from `initAssembly`

Two inputs are validated before any network activity:

- `delegationReason` must be **≤ 256 characters**.
- `enforcementMode` must be one of `"enforce"`, `"observe"`, `"disabled"`.

A value outside these bounds throws a `RangeError` so a typo can't silently register an
agent under the wrong governance posture. See [Configuration](../05-configuration/index.md).

## `PolicyViolationError` at tool call time

This is expected behavior, not a bug: the gateway **denied** the tool call (or an approval
request timed out). The message includes the tool name and the gateway's reason. To run an
agent without blocking while you tune policy, register it with `enforcementMode: "observe"`
— actions proceed and would-be violations are recorded as shadow audit events.

## ESM vs CJS import errors

`import` resolves the ESM entry and `require` resolves the CJS entry automatically via the
package's `exports` map. If a bundler or older toolchain misresolves these, confirm it
honors the `exports` field (rather than the legacy `main`) and see
[Compatibility](../07-compatibility-versioning/compatibility.md#module-systems).
