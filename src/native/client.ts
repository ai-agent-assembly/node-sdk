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

interface NativeBinding {
  connect: (socketPath: string) => Promise<object>;
  sendEvent: (handle: object, event: unknown) => void;
  queryPolicy: (handle: object, query: unknown) => Promise<NativePolicyDecision>;
  disconnect: (handle: object) => Promise<void>;
}

const NATIVE_BINDING_SINGLETON_KEY = Symbol.for("@agent-assembly/sdk/native-binding");

interface GlobalWithNativeBinding {
  [NATIVE_BINDING_SINGLETON_KEY]?: NativeBinding;
}

const ERROR_CONNECT = "AA_ERR_CONNECT";
const ERROR_SEND_EVENT = "AA_ERR_SEND_EVENT";
const ERROR_QUERY_POLICY = "AA_ERR_QUERY_POLICY";
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

export class NativeDisconnectError extends Error {
  readonly code = ERROR_DISCONNECT;
}

export interface NativeClient {
  readonly mode: "grpc-sidecar" | "napi-inprocess";
  close: () => Promise<void>;
  sendEvent: (event: unknown) => void;
  queryPolicy: (action: unknown) => Promise<PolicyResult>;
}

/**
 * Translate the native `{decision, reason}` verdict into the SDK's
 * `PolicyResult`. Only `"deny"` blocks; `"pending"` routes to the approval
 * path; `"allow"` / `"redact"` / any unrecognized value proceed. This mirrors
 * the shared enforcement contract across the Python / Go / Node SDKs.
 *
 * The native primitive already fails open (returns `"allow"`) when the runtime
 * is unreachable or too slow, so a missing or degraded runtime never blocks.
 */
function mapDecisionToPolicyResult(verdict: NativePolicyDecision): PolicyResult {
  switch (verdict.decision) {
    case "deny":
      return { denied: true, pending: false, reason: verdict.reason };
    case "pending":
      return { denied: false, pending: true, reason: verdict.reason };
    default:
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
  const candidates = [
    "../../native/aa-ffi-node/index.cjs",
    "../../../native/aa-ffi-node/index.cjs",
    `${process.cwd()}/native/aa-ffi-node/index.cjs`
  ];

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
    `Failed to load native binding from known paths: ${String(lastError)}`
  );
}

export function createNativeClient(options: InitAssemblyOptions): NativeClient {
  const mode = options.mode ?? "grpc-sidecar";

  if (mode !== "napi-inprocess") {
    return {
      mode,
      close: async () => undefined,
      sendEvent: () => undefined,
      queryPolicy: async () => ({ denied: false, pending: false })
    };
  }

  const binding = loadNativeBinding();
  const socketPath = options.gateway;

  let handlePromise: Promise<object> | undefined;
  let activeHandle: object | undefined;
  let pendingSendError: Error | undefined;

  const getHandle = async (): Promise<object> => {
    if (!handlePromise) {
      handlePromise = binding
        .connect(socketPath)
        .then((handle) => {
          activeHandle = handle;
          return handle;
        })
        .catch((error: unknown) => {
          handlePromise = undefined;
          activeHandle = undefined;
          throw mapNativeError(error);
        });
    }
    return handlePromise;
  };

  return {
    mode,
    close: async () => {
      if (pendingSendError) {
        const error = pendingSendError;
        pendingSendError = undefined;
        throw error;
      }

      if (!handlePromise) {
        return;
      }

      const handle = await getHandle();
      await binding.disconnect(handle).catch((error: unknown) => {
        throw mapNativeError(error);
      });
      handlePromise = undefined;
      activeHandle = undefined;
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
      return mapDecisionToPolicyResult(verdict);
    }
  };
}
