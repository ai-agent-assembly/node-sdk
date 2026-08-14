/**
 * What a {@link GatewayClient} does with the hook layer's audit events —
 * `record`, `recordResult` and `scanPrompts` (AAASM-5681).
 *
 * The hook layer calls those methods on every governed action. Whether anything
 * leaves the process is a property of the client underneath, and until this type
 * existed the SDK had no way to say so: every method returns `Promise<void>`,
 * which is indistinguishable from success whether the event was sent or dropped.
 *
 * Not a boolean, because the SDK can only speak for clients it built, and
 * because "sent" and "dropped" are not the whole vocabulary.
 * `"caller-supplied"` is *not* an assurance that the events are retained — it is
 * the absence of a claim.
 *
 * The ADR 0033 §6 term follows the value, not the SDK as a whole:
 *
 * - `"forwarded"` — the event reaches the runtime's evidence pipeline, which is
 *   what *Observed* requires.
 * - `"discarded"` — no evidence, and the channel that would carry it is not
 *   present in this configuration: *Unsupported*.
 * - `"caller-supplied"` — no claim; whatever the caller's client earns.
 */
export type AuditSinkDisposition =
  /**
   * The client hands hook-layer audit events to the runtime over the native
   * event channel — the same `sendEvent` primitive and the same connected
   * session that already carries the boot registration event. The runtime
   * enriches the frame, re-scans it unconditionally, and admits it to its audit
   * pipeline, so the event reaches the evidence pipeline rather than stopping in
   * this process (AAASM-5750).
   *
   * It says "forwarded", not "recorded", on purpose. This SDK observes that the
   * event crossed the boundary; retention past that point belongs to the runtime
   * and the gateway behind it, and claiming their outcome from here would
   * broaden what this layer can see (ADR 0034). Delivery is best-effort: the
   * native send is fire-and-forget, so a failed send degrades to no record.
   */
  | "forwarded"
  /**
   * The client is known to drop hook-layer audit events, because it holds no
   * channel to send them on. `createNoopGatewayClient` declares this
   * unconditionally, and `createNativeGatewayClient` does so when the native
   * binding could not be loaded. The drop does not change the enforcement
   * posture either way: whether a DENY can block depends on the client's
   * `check`, which is authoritative only in a check-capable run
   * (`napi-inprocess`, or a caller-supplied client). On the no-op client `check`
   * is allow-all. Either way no audit evidence is produced on this path, so no
   * downstream claim of attributability or after-the-fact review holds on it.
   */
  | "discarded"
  /**
   * The client came from the caller, so this SDK does not know what it does
   * with the events and does not claim either way. Whichever §6 term the
   * caller's own client earns is the caller's to establish, not this SDK's to
   * assert.
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
