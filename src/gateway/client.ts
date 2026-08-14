import type {
  AuditSinkDisposition,
  GatewayApprovalResult,
  GatewayCheckRequest,
  GatewayDecision,
  GatewayPromptScan,
  GatewayRecordEvent,
  GatewayResultRecord
} from "../types/gateway-governance.js";
import type { AssemblyMode } from "../types/assembly-mode.js";
import { type EnforcementMode, resolveFailClosed } from "../types/enforcement-mode.js";
import type { NativeClient } from "../native/client.js";

export interface GatewayClient {
  readonly mode: AssemblyMode;
  /**
   * Base URL for the client's HTTP routes. Resolved by ``initAssembly`` to
   * ``controlPlaneUrl`` when set, otherwise to ``gatewayUrl``. Undefined when
   * the client is constructed without a URL (e.g. a bare no-op test client).
   */
  readonly httpBaseUrl?: string;
  /**
   * What this client does with hook-layer audit events (AAASM-5681).
   *
   * Optional so a caller's own `GatewayClient` keeps compiling unchanged; an
   * omitted value is read as `"caller-supplied"`, i.e. this SDK makes no claim
   * about it. Every client this package *ships* must declare its disposition
   * explicitly — `record` / `recordResult` / `scanPrompts` all return
   * `Promise<void>`, so a client that sends the event and one that drops it are
   * otherwise indistinguishable, which is the defect this field closes.
   */
  readonly auditSink?: AuditSinkDisposition;
  start: () => Promise<void>;
  close: () => Promise<void>;
  check: (request: GatewayCheckRequest) => Promise<GatewayDecision>;
  waitForApproval: (
    toolName: string,
    runId: string,
    timeoutMs: number
  ) => Promise<GatewayApprovalResult>;
  record: (event: GatewayRecordEvent) => Promise<void>;
  recordResult: (record: GatewayResultRecord) => Promise<void>;
  scanPrompts: (scan: GatewayPromptScan) => Promise<void>;
}

export function createNoopGatewayClient(mode: AssemblyMode, httpBaseUrl?: string): GatewayClient {
  return {
    mode,
    ...(httpBaseUrl === undefined ? {} : { httpBaseUrl }),
    // AAASM-5681 — the three audit methods below resolve to `undefined` without
    // sending anything. This client holds no transport at all, so there is no
    // channel for AAASM-5750's record path to run over: the gap here is
    // structural, not unwired. Declared so `initAssembly` can surface it and so
    // a test can catch a shipped client that drops without saying so.
    auditSink: "discarded" as AuditSinkDisposition,
    start: async () => undefined,
    close: async () => undefined,
    check: async () => ({ denied: false, pending: false }),
    waitForApproval: async () => ({ denied: false }),
    record: async () => undefined,
    recordResult: async () => undefined,
    scanPrompts: async () => undefined
  };
}

/**
 * Translate a governance check request into the native `queryPolicy` query
 * shape (AAASM-3047). The runtime reads `agent_id`, `action_type`, and — for
 * tool calls — `tool_name` / `args`.
 */
function toNativeQuery(
  request: GatewayCheckRequest,
  agentId: string | undefined
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    agent_id: agentId ?? "",
    action_type: request.action
  };
  if (request.toolName !== undefined) {
    query.tool_name = request.toolName;
  }
  if (request.args !== undefined) {
    query.args = request.args;
  }
  return query;
}

/**
 * A verdict-like object as it arrives at the JS/native boundary: `denied` /
 * `pending` are typed `unknown` here (rather than `boolean | undefined`)
 * because {@link resolveVerdict} exists specifically to distrust that
 * boundary — a version-skewed native binding or a non-conforming
 * `NativeClient` can hand back a shape the compile-time `PolicyResult` /
 * `GatewayApprovalResult` types promise but do not runtime-enforce.
 */
interface RawVerdict {
  denied?: unknown;
  pending?: unknown;
  reason?: unknown;
}

/**
 * Normalize a RESOLVED (non-thrown) verdict or approval result into a
 * well-formed decision (AAASM-4798).
 *
 * `denied: raw.denied ?? false` alone is not a safe default: it treats a
 * verdict that *resolves* without a recognizable `denied` / `pending` signal
 * — `{}`, `{ denied: undefined }`, or a version-skewed native response with
 * the wrong field types — as an authoritative allow. It isn't one; it means
 * no verdict came back at all. That is a different failure mode than the
 * catch-block fault below (a thrown error), but it must fail the same way:
 * under `failClosed` (enforce) it denies; otherwise it stays advisory and
 * allows, so a degraded or mismatched runtime never blocks the agent. Mirrors
 * Python's `_normalize_decision(decision, enforce=enforce)`.
 *
 * Well-formed verdicts (a real `denied` or `pending` boolean) pass through
 * exactly as before this fix.
 *
 * Exported so both consumption sites this guard covers — the `check()`
 * verdict and the `waitForApproval()` approval result — can be tested
 * directly against the same malformed-shape inputs (AAASM-4798).
 */
export function resolveVerdict(
  raw: RawVerdict,
  failClosed: boolean
): { denied: boolean; pending: boolean; reason?: string } {
  const reason = typeof raw.reason === "string" ? raw.reason : undefined;
  const hasRecognizableSignal = typeof raw.denied === "boolean" || typeof raw.pending === "boolean";

  if (!hasRecognizableSignal) {
    const malformedReason =
      reason ??
      (failClosed ? "malformed policy verdict: no recognizable denied/pending signal" : undefined);
    return {
      denied: failClosed,
      pending: false,
      ...(malformedReason === undefined ? {} : { reason: malformedReason })
    };
  }

  return {
    denied: raw.denied === true,
    pending: raw.pending === true,
    ...(reason === undefined ? {} : { reason })
  };
}

/**
 * Gateway client backed by the in-process native runtime (AAASM-3050).
 *
 * `check()` asks a reachable `aa-runtime` for an authoritative verdict via the
 * native `queryPolicy` primitive and maps it onto a `GatewayDecision`:
 *   - `deny`    → `{ denied: true }`  (the wrapper throws `PolicyViolationError`)
 *   - `pending` → `{ pending: true }` (routes to the approval path)
 *   - allow / redact / unspecified → `{ denied: false }`
 *
 * **Enforcement posture (AAASM-3996 — py/go parity, AAASM-3920):** under
 * `enforce` the SDK is a fail-closed control: a caught local fault or an
 * unreachable runtime while querying resolves to `{ denied: true }` so a
 * stalled/killed sidecar cannot turn deny-on-failure into allow-on-failure.
 * In any other posture (`observe` / `disabled` / unset) the SDK stays advisory
 * — the fault is swallowed and resolves neutral (`{ denied: false }`) so a
 * missing or degraded runtime never blocks the agent. The proxy / eBPF layers
 * remain authoritative in every posture.
 *
 * **Malformed resolved verdicts (AAASM-4798):** the above covers a *thrown*
 * fault; a verdict that *resolves* without a recognizable `denied` / `pending`
 * signal goes through {@link resolveVerdict}, which applies the identical
 * fail-closed-under-enforce posture instead of silently defaulting to allow.
 */
export function createNativeGatewayClient(
  mode: AssemblyMode,
  nativeClient: NativeClient,
  agentId?: string,
  httpBaseUrl?: string,
  enforcementMode?: EnforcementMode
): GatewayClient {
  // Fail-closed posture mirrors the go SDK's `failClosed` and the Python
  // enforce guard: an explicit `"enforce"` — or an omitted posture, which
  // defaults to enforce like py/go (AAASM-4172) — denies on fault (AAASM-3920).
  const failClosed = resolveFailClosed(enforcementMode);
  return {
    mode,
    ...(httpBaseUrl === undefined ? {} : { httpBaseUrl }),
    // AAASM-5750 — computed, not fixed. `createNativeGatewayClient` is also
    // handed the fallback stub returned when the native binding could not be
    // loaded (unsupported platform / missing binary), whose `sendEvent` is a
    // no-op; declaring "forwarded" there would be a claim about a channel this
    // client does not hold. `canRegister` is exactly "the native binding loaded",
    // which is the same fact the record path depends on.
    auditSink: (nativeClient.canRegister ? "forwarded" : "discarded") as AuditSinkDisposition,
    start: async () => undefined,
    close: async () => {
      await nativeClient.close();
    },
    check: async (request: GatewayCheckRequest): Promise<GatewayDecision> => {
      try {
        const verdict = await nativeClient.queryPolicy(toNativeQuery(request, agentId));
        return resolveVerdict(verdict, failClosed);
      } catch {
        // Under enforce a local fault / unreachable runtime must deny rather
        // than downgrade to allow-on-failure (AAASM-3996). Otherwise the SDK
        // stays advisory and fails open.
        return { denied: failClosed, pending: false };
      }
    },
    // A `pending` verdict routes here to solicit an approval decision. The node
    // SDK does not yet wire a real approval channel (poll/stream), so no
    // decision can be obtained (AAASM-4129). Under `enforce` this must fail
    // closed — deny — rather than silently downgrade an approval-required
    // verdict to allow, matching python's `_resolve_pending_approval` and go's
    // `WaitForApproval`, both of which deny when no approval channel is wired.
    // In any advisory posture (observe / disabled / unset) it stays neutral so
    // a missing approval channel never blocks the agent.
    //
    // The literal below is itself routed through `resolveVerdict` (AAASM-4798):
    // it is always well-formed today, but doing so keeps this path guarded by
    // the exact same malformed-verdict guard as `check()` so a future real
    // approval channel (AAASM-4129) inherits the fail-closed guarantee instead
    // of relying on a fresh `?? false`.
    waitForApproval: async () => {
      const raw: RawVerdict = failClosed
        ? { denied: true, reason: "approval required but no approval channel is configured" }
        : { denied: false };
      const resolved = resolveVerdict(raw, failClosed);
      return {
        denied: resolved.denied,
        ...(resolved.reason === undefined ? {} : { reason: resolved.reason })
      };
    },
    // AAASM-5750 — the three audit sinks hand their event to the runtime over
    // the native event channel, the same `sendEvent` primitive and the same
    // connected session that already carries the boot registration event
    // (`initAssembly`).
    //
    // The handoff is the claim, and it is deliberately not stated as more than
    // that. `sendEvent` is fire-and-forget and unacknowledged, so this client
    // cannot tell whether the runtime received the event, let alone retained
    // it — see `AuditSinkDisposition` on why none of this reaches §6 *Observed*,
    // and AAASM-5783 for the open downstream work that would have to land first.
    //
    // This supersedes the AAASM-4847 note that said there was nowhere for these
    // to go. That was true of the *gateway* wire — there is still no HTTP audit
    // route for the SDK to POST to — but not of the runtime channel, which was
    // already open and already carrying an event.
    //
    // `sendEvent` never throws: the transport stashes a failure and surfaces it
    // on the next `queryPolicy`. That is deliberate and is why these are safe to
    // call from the hook layer — a failing audit sink must not convert a policy
    // deny into some other error. It does mean a broken IPC channel can deny a
    // later call under `enforce`, which is the correct fail-closed reading of an
    // unreachable runtime rather than an audit-driven enforcement change.
    //
    // Redaction is not attempted here: the runtime's scanner is the
    // unconditional gate on every inbound frame, and a weaker copy on this side
    // would only invite the two to disagree.
    record: async (event: GatewayRecordEvent) => {
      nativeClient.sendEvent({
        event_type: "tool_call_audit",
        action: event.action,
        run_id: event.runId,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.output === undefined ? {} : { output: stringifyForAudit(event.output) })
      });
    },
    recordResult: async (recordEntry: GatewayResultRecord) => {
      nativeClient.sendEvent({
        event_type: "tool_result",
        run_id: recordEntry.runId,
        result: stringifyForAudit(recordEntry.output)
      });
    },
    scanPrompts: async (scan: GatewayPromptScan) => {
      nativeClient.sendEvent({
        event_type: "prompt_scan",
        run_id: scan.runId,
        ...(scan.modelName === undefined ? {} : { model_name: scan.modelName }),
        prompts: scan.prompts.map((prompt) => stringifyForAudit(prompt))
      });
    }
  };
}

/**
 * Render an arbitrary hook-layer value as a string for the audit payload.
 *
 * The native channel takes JSON, and a tool result is `unknown` — it can be a
 * class instance, a circular structure, or a `BigInt`, none of which
 * `JSON.stringify` handles. A throw here would propagate out of `recordResult`
 * into the governed call, so every conversion is guarded.
 *
 * **`String(value)` is not a safe fallback on its own**, which is what the first
 * version of this function assumed. `String()` invokes `Symbol.toPrimitive` /
 * `valueOf` / `toString`, and an object with none of them — anything from
 * `Object.create(null)`, which is what `querystring.parse()` returns — throws
 * `TypeError: Cannot convert object to primitive value`. So the second
 * conversion needs its own guard, and below it a constant that cannot throw at
 * all.
 *
 * This matters more than a lossy field: `AssemblyCallbackHandler.handleToolEnd`
 * awaits this sink without a `try`/`catch`, and `@langchain/core` awaits
 * *that* inside the tool invocation. An unguarded throw here fails the user's
 * tool call — an audit sink must never do that, in either direction.
 */
function stringifyForAudit(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) {
      return encoded;
    }
  } catch {
    // Circular, BigInt, or a throwing `toJSON`. Fall through to `String`.
  }
  try {
    return String(value);
  } catch {
    // No primitive conversion exists. Naming the failure beats propagating it.
    return "[unserializable]";
  }
}
