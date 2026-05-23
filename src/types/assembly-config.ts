import type { GatewayClient } from "../gateway/client.js";
import type { LangChainAdapterConfig } from "./langchain-adapter.js";
import type { AssemblyMode } from "./assembly-mode.js";

export interface AssemblyConfig {
  /**
   * Gateway URL. When omitted, ``initAssembly`` resolves it via
   * AAASM_GATEWAY_URL, ~/.aasm/config.yaml, or the local default
   * (http://localhost:7391, auto-started if absent). See
   * ``agent_assembly/core/gateway-resolver`` for the precedence chain.
   */
  gatewayUrl?: string;
  /**
   * API key. When omitted, ``initAssembly`` resolves it via
   * AAASM_API_KEY, the config file, or defaults to an empty string
   * (local mode is unauth-accepting).
   */
  apiKey?: string;
  agentId?: string;
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
}
