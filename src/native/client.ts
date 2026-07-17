import { createRequire } from "node:module";
import path from "node:path";
import type { InitAssemblyOptions } from "../types/policy.js";

export interface PolicyResult {
  denied?: boolean;
  pending?: boolean;
  reason?: string;
}

/**
 * Policy verdict shape returned by the native `queryPolicy` primitive
 * (AAASM-3047). `decision` is one of `"allow"`, `"deny"`, `"pending"`,
 * `"redact"`; `reason` is the human-readable explanation (or the fail-open
 * note when the runtime did not answer).
 */
interface NativePolicyDecision {
  decision: string;
  reason: string;
}

/**
 * Options for the native `register` primitive (AAASM-3400). `agentId` is the
 * identity the gateway registers; `name` / `framework` are descriptive
 * metadata; `gatewayEndpoint` overrides the gateway gRPC endpoint.
 *
 * `teamId` and `parentAgentId` carry the agent's lineage/team scoping to the
 * gateway on register (AAASM-3415): `teamId` drives team-budget attribution and
 * `parentAgentId` the topology graph. Both optional — omit for a team-unscoped
 * / root agent.
 */
export interface RegisterOptions {
  agentId: string;
  name: string;
  framework: string;
  gatewayEndpoint?: string;
  teamId?: string;
  parentAgentId?: string;
}

interface NativeBinding {
  connect: (socketPath: string, agentId?: string, sdkVersion?: string) => Promise<object>;
  sendEvent: (handle: object, event: unknown) => void;
  queryPolicy: (handle: object, query: unknown) => Promise<NativePolicyDecision>;
  register?: (handle: object, options: RegisterOptions) => Promise<string>;
  disconnect: (handle: object) => Promise<void>;
}

/**
 * Resolve the installed `@agent-assembly/sdk` package version, or `undefined`.
 *
 * Forwarded into the native `connect` so the user-facing npm package version —
 * not the shared `aa-sdk-client` crate version — is what gets signed into the
 * runtime handshake, giving accurate downgrade detection (AAASM-3683).
 * `undefined` lets the native shim fall back to the crate version (no
 * regression vs AAASM-3666). Uses `createRequire(<cwd>/package.json)`, the same
 * ESM/CJS-safe pattern as the native-binding and runtime-binary resolvers.
 */
export function resolveSdkVersion(): string | undefined {
  try {
    const requireFromHere = createRequire(path.resolve(process.cwd(), "package.json"));
    const pkg = requireFromHere("@agent-assembly/sdk/package.json") as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

const NATIVE_BINDING_SINGLETON_KEY = Symbol.for("@agent-assembly/sdk/native-binding");

interface GlobalWithNativeBinding {
  [NATIVE_BINDING_SINGLETON_KEY]?: NativeBinding;
}

const ERROR_CONNECT = "AA_ERR_CONNECT";
const ERROR_SEND_EVENT = "AA_ERR_SEND_EVENT";
const ERROR_QUERY_POLICY = "AA_ERR_QUERY_POLICY";
const ERROR_REGISTER = "AA_ERR_REGISTER";
const ERROR_DISCONNECT = "AA_ERR_DISCONNECT";

export class NativeConnectError extends Error {
  readonly code = ERROR_CONNECT;
}

export class NativeSendEventError extends Error {
  readonly code = ERROR_SEND_EVENT;
}

export class NativeQueryPolicyError extends Error {
  readonly code = ERROR_QUERY_POLICY;
}

export class NativeRegisterError extends Error {
  readonly code = ERROR_REGISTER;
}

export class NativeDisconnectError extends Error {
  readonly code = ERROR_DISCONNECT;
}

export interface NativeClient {
  readonly mode: "grpc-sidecar" | "napi-inprocess";
  /**
   * Whether {@link register} on this transport actually attempts an SDK-side
   * registration against the gateway. `true` whenever the native `aa-sdk-client`
   * binding was loaded — both the in-process (`napi-inprocess`) path and the
   * default (`grpc-sidecar`) path build the same connect+register path over it
   * (AAASM-4468). It is `false` only on the fallback no-op stub returned when the
   * binding could not be loaded (unsupported platform / missing native binary),
   * whose `register` resolves to `""` without contacting anything (see
   * {@link createNativeClient}). Callers must treat a `false` here as "this SDK
   * did not register the agent" rather than trusting `register`'s empty-string
   * success, so `initAssembly` can fail loud instead of reporting a clean init
   * for a registration that structurally never happened (AAASM-4468).
   */
  readonly canRegister: boolean;
  close: () => Promise<void>;
  sendEvent: (event: unknown) => void;
  queryPolicy: (action: unknown) => Promise<PolicyResult>;
  /**
   * Register this agent with the governance gateway over the native
   * SDK→gateway gRPC call (AAASM-3400). The token the gateway issues is stored
   * on the underlying session and attached to every subsequent
   * {@link queryPolicy} request, so the gateway does not deny a registered
   * agent. Returns the assigned policy id.
   *
   * **Advisory:** like the rest of the SDK this is not a security boundary. A
   * failed registration surfaces as a typed error; callers may proceed
   * unregistered (the proxy / eBPF layers remain authoritative).
   */
  register: (options: RegisterOptions) => Promise<string>;
}

/**
 * Reason string the native shim attaches to a fail-open `"allow"` when the
 * runtime does not answer (AAASM-4013). It must stay byte-for-byte identical to
 * `FAIL_OPEN_REASON` in `native/aa-ffi-node/src/lib.rs`: the shim folds
 * `QueryFailed` / `ChannelClosed` / `Shutdown` onto `"allow"` + this reason, so
 * it is the *only* signal the JS layer has to tell "the runtime failed open"
 * apart from a genuine policy `"allow"`. Under `failClosed` that distinction is
 * security-critical.
 */
export const FAIL_OPEN_REASON = "aa-runtime unreachable or slow; failing open (advisory SDK)";

/**
 * Translate the native `{decision, reason}` verdict into the SDK's
 * `PolicyResult`. Only `"deny"` blocks; `"pending"` routes to the approval
 * path; `"allow"` / `"redact"` proceed. This mirrors the shared enforcement
 * contract across the Python / Go / Node SDKs.
 *
 * **Fail-closed (AAASM-4013):** the native shim folds an unreachable / slow /
 * closed runtime onto `"allow"` + {@link FAIL_OPEN_REASON}, and an
 * unspecified / unrecognized runtime verdict onto the empty decision `""`.
 * Neither is an authoritative allow — it is "no verdict came back". When
 * `failClosed` is set (only under `enforcementMode: "enforce"`) these must
 * **deny** rather than silently proceed, matching the Python SDK's enforce
 * posture. When `failClosed` is `false` (observe / disabled / unset) they fail
 * open, preserving the advisory behavior — the proxy / eBPF layers remain
 * authoritative.
 */
function mapDecisionToPolicyResult(
  verdict: NativePolicyDecision,
  failClosed: boolean
): PolicyResult {
  switch (verdict.decision) {
    case "deny":
      return { denied: true, pending: false, reason: verdict.reason };
    case "pending":
      return { denied: false, pending: true, reason: verdict.reason };
    case "allow":
      if (failClosed && verdict.reason === FAIL_OPEN_REASON) {
        return { denied: true, pending: false, reason: verdict.reason };
      }
      return { denied: false, pending: false };
    case "redact":
      // Deliberately folded onto allow, NOT silently dropped. The in-process
      // SDK does not honor `redact` client-side: redaction is a response-body
      // transform owned by the authoritative runtime / proxy layer (aa-runtime,
      // aa-proxy), which sees the full tool I/O this advisory SDK seam does not.
      // No client-side wrapper acts on a redact verdict, so surfacing it as a
      // distinct SDK state would be a no-op that misleads callers into thinking
      // in-process redaction happened. This mirrors the Go SDK's redact handling
      // (AAASM-4788) and keeps the SDK layer's non-authoritative posture honest.
      return { denied: false, pending: false };
    default:
      // Empty / unrecognized decision: the runtime produced no authoritative
      // verdict. Deny under enforce (fail closed); otherwise proceed.
      if (failClosed) {
        return {
          denied: true,
          pending: false,
          reason: verdict.reason || "runtime returned no authoritative decision"
        };
      }
      return { denied: false, pending: false };
  }
}

function mapNativeError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  const [code, ...rest] = error.message.split(":");
  const detail = rest.join(":").trim() || error.message;

  if (code === ERROR_CONNECT) {
    return new NativeConnectError(detail);
  }
  if (code === ERROR_SEND_EVENT) {
    return new NativeSendEventError(detail);
  }
  if (code === ERROR_QUERY_POLICY) {
    return new NativeQueryPolicyError(detail);
  }
  if (code === ERROR_REGISTER) {
    return new NativeRegisterError(detail);
  }
  if (code === ERROR_DISCONNECT) {
    return new NativeDisconnectError(detail);
  }

  return error;
}

function loadNativeBinding(): NativeBinding {
  const shouldUseCache = process.env.VITEST !== "true";
  const globalObject = globalThis as GlobalWithNativeBinding;
  const cachedBinding = shouldUseCache ? globalObject[NATIVE_BINDING_SINGLETON_KEY] : undefined;

  if (cachedBinding) {
    return cachedBinding;
  }

  const requireFromHere = createRequire(path.resolve(process.cwd(), "package.json"));
  // Resolve the binding as a package-internal subpath exported by package.json,
  // so it anchors to the INSTALLED `@agent-assembly/sdk` location regardless of
  // the consumer's `process.cwd()` depth. The former `../../native/...`
  // candidates were resolved relative to `<cwd>/package.json` — i.e. relative to
  // the *consumer's* project root, not this module — so they threw
  // MODULE_NOT_FOUND in every real install and only resolved when cwd happened to
  // be the SDK repo root (AAASM-4468). The relative entries are kept as a
  // best-effort fallback for non-standard layouts and do no harm when the
  // package-subpath resolves first. `import.meta.url` / `__dirname` module-anchor
  // resolution is deliberately avoided: it does not compile under both the ESM
  // and CJS build targets (see `src/runtime.ts`).
  const candidates = [
    "@agent-assembly/sdk/native/aa-ffi-node/index.cjs",
    "../../native/aa-ffi-node/index.cjs",
    "../../../native/aa-ffi-node/index.cjs"
  ];
  if (process.env.AA_ALLOW_CWD_NATIVE_FALLBACK === "1") {
    // Explicit opt-in for non-standard install layouts. See AAASM-4302.
    // Without this env var the CWD candidate is skipped so a malicious
    // package dropped into an attacker-writable CWD cannot hijack the loader.
    candidates.push(`${process.cwd()}/native/aa-ffi-node/index.cjs`);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const binding = requireFromHere(candidate) as NativeBinding;
      if (shouldUseCache) {
        globalObject[NATIVE_BINDING_SINGLETON_KEY] = binding;
      }
      return binding;
    } catch (error) {
      lastError = error;
    }
  }

  throw new NativeConnectError(
    `Failed to load native binding from known paths: ${String(lastError)}. ` +
      `For non-standard install layouts, set AA_ALLOW_CWD_NATIVE_FALLBACK=1 ` +
      `to also probe <cwd>/native/aa-ffi-node/index.cjs (see AAASM-4302).`
  );
}

/**
 * The fallback no-op {@link NativeClient} returned when the native
 * `aa-sdk-client` binding cannot be loaded (unsupported platform / missing
 * native binary). `canRegister: false` is what lets `initAssembly` fail loud
 * about the unregistered agent instead of trusting the stub's empty-string
 * `register` "success" (AAASM-4468).
 */
function buildStubClient(mode: NativeClient["mode"]): NativeClient {
  return {
    mode,
    canRegister: false,
    close: async () => undefined,
    sendEvent: () => undefined,
    queryPolicy: async () => ({ denied: false, pending: false }),
    // No native session to register against; resolve neutrally so init never
    // blocks on a transport that does not own a handle.
    register: async () => ""
  };
}

/**
 * Build a registration-capable {@link NativeClient} backed by the native
 * `aa-sdk-client` binding. Shared by the in-process (`napi-inprocess`) path and
 * the default (`grpc-sidecar`) path: both connect a session over `socketPath`,
 * register the agent via the direct SDK→gateway gRPC call (ADR 0004), and route
 * `queryPolicy` through the runtime. `failClosed` denies on a non-authoritative
 * verdict under enforce (AAASM-4013).
 */
function buildConnectedClient(
  binding: NativeBinding,
  mode: NativeClient["mode"],
  socketPath: string,
  failClosed: boolean
): NativeClient {
  let handlePromise: Promise<object> | undefined;
  let activeHandle: object | undefined;
  let pendingSendError: Error | undefined;

  const sdkVersion = resolveSdkVersion();

  const getHandle = async (): Promise<object> => {
    handlePromise ??= binding
      // Forward the npm package version so it is signed into the handshake
      // (AAASM-3683); agent id is wired at register time, not connect.
      .connect(socketPath, undefined, sdkVersion)
      .then((handle) => {
        activeHandle = handle;
        return handle;
      })
      .catch((error: unknown) => {
        handlePromise = undefined;
        activeHandle = undefined;
        throw mapNativeError(error);
      });
    return handlePromise;
  };

  return {
    mode,
    // The in-process path dials the native binding and attempts a real
    // SDK→gateway registration below, so it is registration-capable.
    canRegister: true,
    close: async () => {
      // A stashed advisory send error must not short-circuit teardown: capture
      // it, still run `disconnect` so the native session is actually released,
      // and only re-throw it once the handle is torn down (AAASM-4699).
      // Previously an early throw here left the session connected and
      // `activeHandle`/`handlePromise` set, leaking a live session on every
      // shutdown that followed a failed advisory send.
      const stashedSendError = pendingSendError;
      pendingSendError = undefined;

      if (handlePromise) {
        const handle = await getHandle();
        try {
          await binding.disconnect(handle);
        } catch (error) {
          throw mapNativeError(error);
        } finally {
          handlePromise = undefined;
          activeHandle = undefined;
        }
      }

      if (stashedSendError) {
        throw stashedSendError;
      }
    },
    sendEvent: (event: unknown) => {
      if (activeHandle) {
        try {
          binding.sendEvent(activeHandle, event);
        } catch (error) {
          pendingSendError = mapNativeError(error);
        }
        return;
      }

      void getHandle()
        .then((handle) => {
          binding.sendEvent(handle, event);
        })
        .catch((error: unknown) => {
          pendingSendError = mapNativeError(error);
        });
    },
    queryPolicy: async (action: unknown) => {
      if (pendingSendError) {
        const error = pendingSendError;
        pendingSendError = undefined;
        throw error;
      }

      // Connect (surfacing any connect error as a genuine local fault), then
      // ask the runtime for an authoritative verdict via the native primitive.
      // The native `queryPolicy` is async — it offloads its blocking wait to a
      // worker thread, so awaiting it never blocks the Node event loop — and it
      // already fails open (returns `"allow"`) when the runtime is unreachable
      // or too slow, so a missing or degraded runtime never blocks the agent.
      const handle = await getHandle();
      const verdict = await binding.queryPolicy(handle, action);
      return mapDecisionToPolicyResult(verdict, failClosed);
    },
    register: async (options: RegisterOptions) => {
      // Register on the same session the queryPolicy path uses, so the token
      // the gateway issues is stored on this handle and attached to every
      // subsequent query. This is the only direct SDK→gateway gRPC call
      // (ADR 0004); CheckAction still flows through aa-runtime.
      if (binding.register === undefined) {
        // A binding without `register` predates AAASM-3400; the agent simply
        // runs unregistered rather than failing init.
        return "";
      }
      const handle = await getHandle();
      return binding.register(handle, options).catch((error: unknown) => {
        throw mapNativeError(error);
      });
    }
  };
}

/**
 * Construct the native transport for a mode.
 *
 * Both `napi-inprocess` and the default `grpc-sidecar` route registration and
 * policy checks through the shared `aa-sdk-client` napi binding — the SDK never
 * reimplements the gateway handshake in JS (ADR 0002 / 0004). They differ only
 * in failure posture:
 *  - `napi-inprocess` requires the binding: a load failure throws
 *    {@link NativeConnectError} (the caller explicitly opted into in-process
 *    enforcement, so a missing binding is a hard error).
 *  - the default `grpc-sidecar` path *attempts* the binding and falls back to a
 *    no-op stub on load failure (unsupported platform such as Windows, or a
 *    missing native binary), so `initAssembly` can fail loud about the
 *    unregistered agent rather than crashing (AAASM-4468).
 *
 * Fail-closed posture (AAASM-4013) defaults to fail-open so observe / disabled /
 * unset modes are unchanged.
 */
export function createNativeClient(options: InitAssemblyOptions): NativeClient {
  const mode = options.mode ?? "grpc-sidecar";
  const failClosed = options.failClosed ?? false;

  if (mode === "napi-inprocess") {
    return buildConnectedClient(loadNativeBinding(), "napi-inprocess", options.gateway, failClosed);
  }

  let binding: NativeBinding;
  try {
    binding = loadNativeBinding();
  } catch {
    return buildStubClient("grpc-sidecar");
  }
  return buildConnectedClient(binding, "grpc-sidecar", options.gateway, failClosed);
}
