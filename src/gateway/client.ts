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
   * `Promise<void>`, so a discarding client is otherwise indistinguishable from
   * a recording one, which is the defect this field closes.
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
    // retaining anything. Declared so `initAssembly` can surface the gap and so
    // a test can catch a shipped client that discards without saying so.
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
    // AAASM-5681 — hook-layer audit events are dropped here (see the comment on
    // `record` below). Declared rather than left implicit so the drop reaches
    // `initAssembly`, and through it the caller, without `AA_DEBUG=1`.
    auditSink: "discarded" as AuditSinkDisposition,
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
    // Audit/telemetry sinks are intentional no-ops in napi-inprocess mode
    // (AAASM-4847). The native `aa-sdk-client` runtime this client wraps records
    // its own policy-decision events in-process against the embedded runtime;
    // there is no separate gateway wire for the SDK to POST audit events to, so
    // hook-layer `record` / `recordResult` / `scanPrompts` calls have nowhere to
    // go here and are dropped. This is a deliberate, accepted telemetry gap — NOT
    // an enforcement gap: allow/deny still flows through `check` /
    // `waitForApproval` above, consistent with this SDK's non-authoritative
    // posture (`aa-runtime` in the monorepo is the authoritative point). If the
    // hook layer's audit events ever need to reach a central sink from this mode,
    // that is a new wiring task, not a bug to patch here. Emit a one-time,
    // opt-in debug note so the drop is discoverable rather than silent.
    record: async () => {
      noteNativeAuditNoop();
    },
    recordResult: async () => {
      noteNativeAuditNoop();
    },
    scanPrompts: async () => {
      noteNativeAuditNoop();
    }
  };
}

/**
 * One-time, opt-in (`AA_DEBUG=1`) note that hook-layer audit events are being
 * dropped in napi-inprocess mode. Kept behind a debug flag and fired at most
 * once so it documents the accepted telemetry gap (AAASM-4847) for anyone
 * debugging "where did my audit events go" without adding steady-state noise.
 */
let nativeAuditNoopNoted = false;
function noteNativeAuditNoop(): void {
  if (nativeAuditNoopNoted || process.env.AA_DEBUG !== "1") {
    return;
  }
  nativeAuditNoopNoted = true;
  process.stderr.write(
    `[agent-assembly] DEBUG: napi-inprocess gateway client drops hook-layer ` +
      `audit events (record/recordResult/scanPrompts) — enforcement is ` +
      `unaffected; this is an accepted telemetry gap (AAASM-4847).\n`
  );
}
