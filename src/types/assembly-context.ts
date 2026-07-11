import type { EnforcementMode } from "./enforcement-mode.js";

export interface AssemblyContext {
  readonly activeAdapters: readonly string[];
  /**
   * Whether this SDK actually registered the agent with the governance gateway
   * during `initAssembly`. `false` means the agent will **not** appear in the
   * dashboard / `/api/v1/agents` unless an external registrar (e.g. a sidecar)
   * performs it out-of-band. It is `false` for the default `grpc-sidecar` mode,
   * whose in-SDK registration is a no-op stub pending AAASM-4467, and for
   * `sdk-only` mode (no network layer); a matching stderr warning is emitted at
   * init time. Exposed so callers can detect the unregistered state
   * programmatically rather than relying on the warning alone (AAASM-4468).
   */
  readonly registered: boolean;
  readonly parentAgentId?: string;
  readonly teamId?: string;
  readonly delegationReason?: string;
  readonly spawnedByTool?: string;
  /** Echo of the per-agent governance posture sent at registration, when set. */
  readonly enforcementMode?: EnforcementMode;
  shutdown: () => Promise<void>;
}
