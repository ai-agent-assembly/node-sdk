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
  ToolMap,
} from "./types/index.js";
export {
  decodeAuditEvent,
  decodeCallStackNode,
  encodeAuditEvent,
  encodeCallStackNode,
} from "./audit/index.js";
export type {
  WireAuditEvent,
  WireCallStackNode,
} from "./audit/index.js";
export { currentAgentId, runWithAgentId } from "./lineage/index.js";
