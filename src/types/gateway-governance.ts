/**
 * What a {@link GatewayClient} does with the hook layer's audit events —
 * `record`, `recordResult` and `scanPrompts` (AAASM-5681).
 *
 * The hook layer calls those methods on every governed action. Whether anything
 * is retained is a property of the client underneath, and until this type
 * existed the SDK had no way to say so: both clients it ships discard the event
 * and return `Promise<void>`, which is indistinguishable from success.
 *
 * Deliberately two-valued rather than a boolean, because the SDK can only speak
 * for clients it built. `"caller-supplied"` is *not* an assurance that the
 * events are retained — it is the absence of a claim.
 */
export type AuditSinkDisposition =
  /**
   * The client is known to drop hook-layer audit events. Both shipped clients
   * declare this. Enforcement is unaffected — allow/deny still flows through
   * `check` / `waitForApproval` — but no audit evidence is produced, so no
   * downstream claim of attributability or after-the-fact review holds on this
   * path. ADR 0033 §6: recording here is **Planned** (AAASM-5681), not
   * *Observed*.
   */
  | "discarded"
  /**
   * The client came from the caller, so this SDK does not know what it does
   * with the events and does not claim either way. An *Observed* claim for the
   * hook layer is available only on this branch, and only if the caller's own
   * client actually retains the event.
   */
  | "caller-supplied";

export interface GatewayCheckRequest {
  action: "tool_call" | "llm_start" | "llm_end" | "other";
  toolName?: string;
  args?: unknown;
  runId: string;
}

export interface GatewayDecision {
  denied?: boolean;
  pending?: boolean;
  reason?: string;
}

export interface GatewayApprovalResult {
  denied?: boolean;
  reason?: string;
}

export interface GatewayRecordEvent {
  action: string;
  runId: string;
  reason?: string;
  output?: unknown;
}

export interface GatewayPromptScan {
  prompts: readonly string[];
  runId: string;
  modelName?: string;
}

export interface GatewayResultRecord {
  runId: string;
  output: unknown;
}
