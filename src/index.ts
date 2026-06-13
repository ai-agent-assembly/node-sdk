export { initAssembly } from "./core/init-assembly.js";
export { withAssembly } from "./wrappers/index.js";
export type { WithAssemblyOptions } from "./wrappers/index.js";
export type {
  AssemblyConfig,
  AssemblyContext,
  AssemblyMode,
  AuditEvent,
  CallStackNode,
  CallStackNodeKind,
  EnforcementMode,
  ToolMap
} from "./types/index.js";
export { ENFORCEMENT_MODES } from "./types/index.js";
export {
  decodeAuditEvent,
  decodeCallStackNode,
  encodeAuditEvent,
  encodeCallStackNode
} from "./audit/index.js";
export type { WireAuditEvent, WireCallStackNode } from "./audit/index.js";
export { currentAgentId, runWithAgentId } from "./lineage/index.js";
// Runtime binary resolution helpers (F113 / AAASM-1221). Re-export the
// discovery + error-message surfaces from src/runtime.ts; the lifecycle
// `initAssembly` from runtime.ts intentionally stays scoped to the
// `@agent-assembly/sdk/runtime` subpath export to avoid colliding with
// the gateway-based `initAssembly` re-exported above.
export { INSTALL_HINT, findAasmBinary } from "./runtime.js";
export type { GatewayClient } from "./gateway/index.js";
export type {
  GatewayApprovalResult,
  GatewayCheckRequest,
  GatewayDecision,
  GatewayPromptScan,
  GatewayRecordEvent,
  GatewayResultRecord
} from "./types/index.js";
