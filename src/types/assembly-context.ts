import type { EnforcementMode } from "./enforcement-mode.js";

export interface AssemblyContext {
  /**
   * Frameworks this SDK is actually governing for this run — those whose patch
   * took effect. A framework that was detected but whose patch failed or was
   * inert is **not** listed here (AAASM-5664); it appears in
   * {@link AssemblyContext.unpatchedAdapters} instead, alongside the stderr
   * warning emitted at init. Treat presence here, and only here, as the signal
   * that in-process governance is in force for that framework.
   */
  readonly activeAdapters: readonly string[];
  /**
   * Frameworks found installed in the environment, whether or not their patch
   * succeeded. Always a superset of the detected part of `activeAdapters`;
   * useful to distinguish "the framework is not installed" from "the framework
   * is installed but ungoverned", which an omission from `activeAdapters`
   * alone cannot tell you apart.
   */
  readonly detectedAdapters: readonly string[];
  /**
   * Detected frameworks whose patch did not take effect — it failed, was inert
   * (e.g. the frozen-ESM Vercel shape, AAASM-4842), or was skipped for a
   * missing prerequisite such as `agentId`. Tool calls made through these
   * frameworks are **not** governed by this SDK, so a non-empty value here is
   * the programmatic counterpart to the init-time stderr warning.
   */
  readonly unpatchedAdapters: readonly string[];
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
