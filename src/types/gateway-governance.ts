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
 * **No value here earns ADR 0033 §6 *Observed*.** §6's evidence column requires
 * *a durable event attributed to the action*, and the SDK cannot establish that
 * from this side — see the note on `"forwarded"`. The strongest claim available
 * to this type is about where the event was handed, not where it ended up.
 */
export type AuditSinkDisposition =
  /**
   * The client hands hook-layer audit events to the runtime over the native
   * event channel — the same `sendEvent` primitive and the same session that
   * already carries the boot registration event (AAASM-5750).
   *
   * **That handoff is the whole of the claim.** `sendEvent` returns `void`, is
   * fire-and-forget, and never throws — the transport stashes a failure and
   * surfaces it on a later `queryPolicy` — so this SDK does not learn whether
   * the runtime received the event, and a client whose underlying connect never
   * succeeds still reports `"forwarded"`. It says "forwarded" rather than
   * "recorded" for that reason, and it must not be read as *Observed*: what the
   * runtime and the gateway behind it retain is theirs to state, and is not
   * established by this value.
   */
  | "forwarded"
  /**
   * The client is known to drop hook-layer audit events, because it holds no
   * channel to send them on. `createNoopGatewayClient` declares this, and it is
   * the client `auto` / `sdk-only` / `grpc-sidecar` resolve — so this is the
   * default path. §6: *Unsupported*, since no sink exists in that configuration.
   *
   * `createNativeGatewayClient` also reports it when handed a `NativeClient`
   * whose binding never loaded. `initAssembly` cannot reach that state —
   * `napi-inprocess` throws on a load failure and every other mode returns the
   * no-op client — but the factory is exported, so a caller constructing one
   * directly can.
   *
   * The drop does not change the enforcement posture either way: whether a DENY
   * can block depends on the client's `check`, which is authoritative only in a
   * check-capable run (`napi-inprocess`, or a caller-supplied client). On the
   * no-op client `check` is allow-all. Either way no audit evidence is produced
   * on this path, so no downstream claim of attributability or after-the-fact
   * review holds on it.
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
