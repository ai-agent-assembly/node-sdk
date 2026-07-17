import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { GatewayClient } from "../../gateway/client.js";

function getSerializedName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as { name?: unknown }).name;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Audit-only LangChain callback handler: records tool/LLM lifecycle events
 * (denials, results, prompt scans) with the gateway. It intentionally does
 * NOT block or redact tool output — `@langchain/core` discards a callback
 * handler's `handleToolEnd` return value (the real tool invocation always
 * returns its own output regardless), so a callback can only observe, never
 * preempt. Real pre-execution enforcement lives in `wrapToolWithAssembly`
 * (see `wrap-tool-with-assembly.ts`); `initAssembly` wires both. (AAASM-4799)
 */
export class AssemblyCallbackHandler extends BaseCallbackHandler {
  readonly name = "assembly_handler";
  private readonly pendingDenials = new Map<string, { reason: string; at: number }>();

  constructor(
    private readonly gateway: GatewayClient,
    private readonly now: () => number = () => Date.now(),
    private readonly pendingDenialMaxAgeMs: number = 5 * 60 * 1000
  ) {
    super();
  }

  async handleToolStart(tool: { name?: string }, input: unknown, runId: string): Promise<void> {
    this.cleanupExpiredPendingDenials();

    const toolName = tool.name ?? getSerializedName(tool) ?? "unknown_tool";
    const decision = await this.gateway.check({
      action: "tool_call",
      toolName,
      args: input,
      runId
    });

    // Set pending-denial bookkeeping before the (network) record() call so a
    // record() failure can never silently drop it - handleToolEnd's audit
    // signal depends on this map, not on record() having succeeded.
    if (decision.denied) {
      this.pendingDenials.set(runId, {
        reason: decision.reason ?? "Tool denied by policy.",
        at: this.now()
      });
    }

    await this.gateway.record({
      action: "tool_start_check",
      runId,
      ...(decision.reason ? { reason: decision.reason } : {})
    });
  }

  async handleToolEnd(output: unknown, runId: string): Promise<unknown> {
    this.cleanupExpiredPendingDenials();

    const pending = this.pendingDenials.get(runId);
    if (pending) {
      this.pendingDenials.delete(runId);
      // Audit-only: @langchain/core's tool invocation (see
      // `@langchain/core/dist/tools/index.cjs`) does
      // `await runManager?.handleToolEnd(formattedOutput); return formattedOutput;` -
      // it awaits this handler but always returns the original output regardless
      // of what we return here. This handler cannot block or redact tool output;
      // that requires wrapToolWithAssembly, which enforces pre-execution. This
      // record exists purely so a deny surfaced at handleToolStart but not
      // enforced (e.g. an unwrapped tool) is still visible in the audit trail.
      await this.gateway.record({
        action: "policy_post_block",
        runId,
        reason: pending.reason
      });
      return output;
    }

    await this.gateway.recordResult({ runId, output });
    return output;
  }

  async handleLLMStart(llm: { name?: string }, prompts: string[], runId: string): Promise<void> {
    this.cleanupExpiredPendingDenials();

    const modelName = llm.name ?? getSerializedName(llm);
    await this.gateway.scanPrompts({
      prompts,
      runId,
      ...(modelName ? { modelName } : {})
    });
  }

  async handleLLMEnd(output: unknown, runId: string): Promise<void> {
    this.cleanupExpiredPendingDenials();

    await this.gateway.record({
      action: "llm_response",
      runId,
      output
    });
  }

  cleanupExpiredPendingDenials(now: number = this.now()): number {
    let removed = 0;
    for (const [runId, denial] of this.pendingDenials.entries()) {
      if (now - denial.at >= this.pendingDenialMaxAgeMs) {
        this.pendingDenials.delete(runId);
        removed += 1;
      }
    }
    return removed;
  }

  // Exposed for deterministic unit testing around cleanup behavior.
  getPendingDenialCount(): number {
    return this.pendingDenials.size;
  }
}
