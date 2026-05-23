import type { EnforcementMode } from "./enforcement-mode.js";

export interface AssemblyContext {
  readonly activeAdapters: readonly string[];
  readonly parentAgentId?: string;
  readonly teamId?: string;
  readonly delegationReason?: string;
  readonly spawnedByTool?: string;
  /** Echo of the per-agent governance posture sent at registration, when set. */
  readonly enforcementMode?: EnforcementMode;
  shutdown: () => Promise<void>;
}
