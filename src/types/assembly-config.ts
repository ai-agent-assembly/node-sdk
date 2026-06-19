import type { GatewayClient } from "../gateway/client.js";
import type { LangChainAdapterConfig } from "./langchain-adapter.js";
import type { AssemblyMode } from "./assembly-mode.js";
import type { EnforcementMode } from "./enforcement-mode.js";

export interface AssemblyConfig {
  /**
   * Gateway URL. When omitted, ``initAssembly`` resolves it via
   * AAASM_GATEWAY_URL, ~/.aasm/config.yaml, or the local default
   * (http://localhost:7391, auto-started if absent). See
   * ``agent_assembly/core/gateway-resolver`` for the precedence chain.
   */
  gatewayUrl?: string;
  /**
   * Control-plane HTTP base URL. When set, the gateway client routes its HTTP
   * traffic here instead of ``gatewayUrl``; when omitted it falls back to the
   * resolved ``gatewayUrl`` (backwards-compatible). ``initAssembly`` also reads
   * the ``AA_CONTROL_PLANE_URL`` environment variable as a fallback when this
   * field is not set. The gRPC transport continues to use ``gatewayUrl``.
   */
  controlPlaneUrl?: string;
  /**
   * API key. When omitted, ``initAssembly`` resolves it via
   * AAASM_API_KEY, the config file, or defaults to an empty string
   * (local mode is unauth-accepting).
   */
  apiKey?: string;
  agentId?: string;
  /**
   * Human-readable agent name recorded by the gateway at registration
   * (AAASM-3400). Descriptive metadata only; when omitted it falls back to
   * ``agentId``.
   */
  name?: string;
  mode?: AssemblyMode;
  gatewayClient?: GatewayClient;
  langchain?: LangChainAdapterConfig;
  /** ID of the parent agent that delegated work to this agent. */
  parentAgentId?: string;
  /** Team this agent belongs to for budget and policy scoping. */
  teamId?: string;
  /**
   * Human-readable explanation for why this agent was delegated to.
   * Must be ≤ 256 characters; throws `RangeError` otherwise.
   */
  delegationReason?: string;
  /** Name of the tool that spawned this agent, if applicable. */
  spawnedByTool?: string;
  /**
   * Per-agent governance posture override sent to the gateway at registration.
   *
   * When omitted, the field is left off the registration body and the gateway
   * applies its server-side default (live `"enforce"`) — the pre-feature wire
   * shape is preserved. Pass `"observe"` to register this agent in dry-run /
   * sandbox mode (every action proceeds; the gateway records would-be
   * violations as shadow audit events surfaced by `aa audit list --dry-run-only`).
   *
   * Unknown string values are rejected at runtime with a `RangeError`.
   */
  enforcementMode?: EnforcementMode;
}
