import type {
  GatewayApprovalResult,
  GatewayCheckRequest,
  GatewayDecision,
  GatewayPromptScan,
  GatewayRecordEvent,
  GatewayResultRecord
} from "../types/gateway-governance.js";
import type { AssemblyMode } from "../types/assembly-mode.js";

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

export function createNoopGatewayClient(
  mode: AssemblyMode,
  httpBaseUrl?: string
): GatewayClient {
  return {
    mode,
    ...(httpBaseUrl !== undefined ? { httpBaseUrl } : {}),
    start: async () => undefined,
    close: async () => undefined,
    check: async () => ({ denied: false, pending: false }),
    waitForApproval: async () => ({ denied: false }),
    record: async () => undefined,
    recordResult: async () => undefined,
    scanPrompts: async () => undefined
  };
}
