import type {
  GatewayApprovalResult,
  GatewayCheckRequest,
  GatewayDecision,
  GatewayPromptScan,
  GatewayRecordEvent,
  GatewayResultRecord
} from "../types/gateway-governance.js";
import type { AssemblyMode } from "../types/assembly-mode.js";
import type { EnforcementMode } from "../types/enforcement-mode.js";
import type { NativeClient } from "../native/client.js";

export interface GatewayClient {
  readonly mode: AssemblyMode;
  /**
   * Base URL for the client's HTTP routes. Resolved by ``initAssembly`` to
   * ``controlPlaneUrl`` when set, otherwise to ``gatewayUrl``. Undefined when
   * the client is constructed without a URL (e.g. a bare no-op test client).
   */
  readonly httpBaseUrl?: string;
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
 */
export function createNativeGatewayClient(
  mode: AssemblyMode,
  nativeClient: NativeClient,
  agentId?: string,
  httpBaseUrl?: string,
  enforcementMode?: EnforcementMode
): GatewayClient {
  // Fail-closed posture mirrors the go SDK's `failClosed` and the Python
  // enforce guard: only an explicit `"enforce"` denies on fault (AAASM-3920).
  const failClosed = enforcementMode === "enforce";
  return {
    mode,
    ...(httpBaseUrl === undefined ? {} : { httpBaseUrl }),
    start: async () => undefined,
    close: async () => {
      await nativeClient.close();
    },
    check: async (request: GatewayCheckRequest): Promise<GatewayDecision> => {
      try {
        const verdict = await nativeClient.queryPolicy(toNativeQuery(request, agentId));
        return {
          denied: verdict.denied ?? false,
          pending: verdict.pending ?? false,
          ...(verdict.reason === undefined ? {} : { reason: verdict.reason })
        };
      } catch {
        // Under enforce a local fault / unreachable runtime must deny rather
        // than downgrade to allow-on-failure (AAASM-3996). Otherwise the SDK
        // stays advisory and fails open.
        return { denied: failClosed, pending: false };
      }
    },
    waitForApproval: async () => ({ denied: false }),
    record: async () => undefined,
    recordResult: async () => undefined,
    scanPrompts: async () => undefined
  };
}
