import type { EnforcementMode } from "./enforcement-mode.js";

export interface AssemblyContext {
  /**
   * Frameworks whose patch was **applied and is reachable by the caller** this run.
   *
   * This is a statement about mechanism, not a guarantee of enforcement. What an
   * applied patch buys differs per framework and per mode, so membership here is
   * necessary but **not sufficient** for a policy DENY to block a call:
   *
   * - `langgraph-js`, `mastra` — lineage tagging only (`NON_ENFORCING_MODULES`,
   *   AAASM-4830). These earn **no ADR 0033 §6 term of their own**: the patch wraps
   *   the call in an `AsyncLocalStorage` binding of the agent id and nothing else —
   *   it emits no event, requests no decision, and runs no check. What it provides
   *   is attribution: any evidence produced by *another* layer during the call
   *   carries this agent's id. Judged on its own, an in-process LangGraph or Mastra
   *   tool call is §6 *Unmeasured*, and a DENY never blocks it in-process.
   * - `langchain-js` — two layers with different powers (AAASM-4799). Only tools
   *   passed through `langchain.tools` and wrapped by `wrapToolWithAssembly` reach
   *   *Denied before execution*. The callback handler is audit-only and cannot
   *   block; it reaches *Observed* only when the gateway client actually persists
   *   what it records, which the default no-op client and the `napi-inprocess`
   *   client both do not (`record`/`recordResult` are deliberate no-ops there,
   *   AAASM-4847) — so in practice that requires a caller-supplied client.
   * - `vercel-ai-sdk`, `openai-agents` — the governed tool factory is installed and
   *   the refusal precedes the effect, so these reach *Denied before execution*.
   *
   * Independently of the above, an enforcing path only reaches *Denied before
   * execution* in a check-capable run — `napi-inprocess`, or a caller-supplied
   * `gatewayClient`. Otherwise `check()` is the allow-all no-op stub, which produces
   * no control-plane decision record: the call is then not even *Evaluated*, it is
   * §6 *Unmeasured* in-process. `initAssembly` warns on stderr when that applies.
   *
   * All of the above is scoped to what this SDK does **in-process**. Per §6,
   * *Unmeasured* here does not mean the activity was unobserved elsewhere — the
   * proxy and eBPF layers are independent and may still see the same traffic.
   *
   * A framework that was detected but whose patch failed, was inert, or was
   * unreachable is **not** listed here (AAASM-5664) — see
   * {@link AssemblyContext.unpatchedAdapters}.
   */
  readonly activeAdapters: readonly string[];
  /**
   * Frameworks found installed in the environment, whether or not their patch was
   * applied. Lets a caller distinguish "the framework is not installed" from "the
   * framework is installed but this SDK is not attached to it" — an omission from
   * {@link AssemblyContext.activeAdapters} alone cannot tell those apart.
   *
   * **This is not a superset of `activeAdapters`.** A framework configured
   * explicitly rather than auto-detected is active without being detected: today
   * that is `langchain-js` only, which an explicit `langchain` config wires up even
   * when `@langchain/core` does not resolve. The invariants that do hold are:
   *
   * - `unpatchedAdapters === detectedAdapters \ activeAdapters`
   * - `detectedAdapters === activeAdapters ∪ unpatchedAdapters` **minus** any
   *   explicitly-configured id, which appears only in `activeAdapters`
   *
   * So `detected.filter(d => active.includes(d))` is not "the governed frameworks";
   * read `activeAdapters` directly for that.
   */
  readonly detectedAdapters: readonly string[];
  /**
   * Detected frameworks whose patch was **not** applied — it failed, was inert (the
   * frozen-ESM Vercel shape, AAASM-4842), was skipped for a missing prerequisite such
   * as `agentId`, or landed somewhere the caller cannot reach (`@langchain/core`
   * installed with no `langchain` config, AAASM-5664). This SDK does not observe or
   * govern these frameworks at all, so a non-empty value is the programmatic
   * counterpart to the init-time stderr warning.
   *
   * An empty value means nothing *detected* was left unattached. It is **not** an
   * all-clear that everything active is enforcing — see `activeAdapters` for why
   * membership there is not an enforcement guarantee.
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
