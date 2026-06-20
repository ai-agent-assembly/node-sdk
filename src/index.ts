export { initAssembly } from "./core/init-assembly.js";
export { withAssembly } from "./wrappers/index.js";
export type { OpControl, WithAssemblyOptions } from "./wrappers/index.js";
// Live op-control consumer (AAASM-3491). Subscribes to the gateway's
// OpControlStream and exposes per-op cooperative-pause / fast-fail-terminate;
// pass the subscriber as `withAssembly(..., { opControl })` so an operator
// terminate/pause reaches a running tool through the SDK tool path.
export { OpControlSubscriber } from "./op-control.js";
export type {
  OpControlClient,
  OpControlSubscriberOptions
} from "./op-control.js";
export { OpTerminatedError } from "./errors/op-terminated-error.js";
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
export { createNoopGatewayClient } from "./gateway/index.js";
export { PolicyViolationError } from "./errors/index.js";
// Per-framework governance patch hooks (AAASM-2922). The curated public
// surface lives in src/hooks/index.ts; re-export it here and via the
// `@agent-assembly/sdk/hooks` subpath so consumers can apply a single
// framework's hook manually.
export * from "./hooks/index.js";
