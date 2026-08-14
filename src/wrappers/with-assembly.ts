import { randomUUID } from "node:crypto";
import { isSeamWritable } from "../core/tool-seam-guard.js";
import { OpTerminatedError } from "../errors/op-terminated-error.js";
import { PolicyViolationError } from "../errors/policy-violation-error.js";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolMap } from "../types/tool-map.js";

/**
 * Narrow seam onto the live op-control consumer (AAASM-3491).
 *
 * The wrapper only needs to *wait until an op is runnable* — a pause blocks
 * here cooperatively, a terminate rejects with {@link OpTerminatedError}.
 * Depending on this strip rather than the concrete `OpControlSubscriber` keeps
 * the wrapper decoupled from the gRPC transport and lets tests drive it without
 * a live stream; the real `OpControlSubscriber` satisfies it structurally. This
 * mirrors the Python companion's `build_governance_interceptor(op_control=...)`
 * seam.
 */
export interface OpControl {
  waitForOp(opId: string, opts?: { timeoutMs?: number }): Promise<void>;
}

export interface WithAssemblyOptions {
  gatewayClient: GatewayClient;
  agentId?: string;
  approvalTimeoutMs?: number;
  /**
   * Live op-control consumer. When supplied, the gateway kill switch
   * (AAASM-3491) is honored *in this tool path*: before the pre-exec gateway
   * check, a terminated op fast-fails the call and a paused op blocks
   * cooperatively until the gateway resumes it. Optional — without it the tool
   * path behaves exactly as before (gateway check + approval only), and op
   * control reaches the agent solely via the native runtime's own stream.
   */
  opControl?: OpControl;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

/**
 * Resolve the op id (`"{traceId}:{spanId}"`) for a wrapped tool call.
 *
 * Prefers an explicit `opId` on the call's first argument; otherwise composes
 * it from `traceId` / `spanId` when an adapter threads them through. Returns
 * `undefined` when no trace identity is present — the call is not part of a
 * tracked op, so there is nothing for the kill switch to address and op control
 * is skipped. Mirrors the Python companion's `_extract_op_id`.
 */
function extractOpId(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const fields = first as Record<string, unknown>;
  const opId = fields.opId;
  if (typeof opId === "string" && opId.length > 0) {
    return opId;
  }
  const traceId = fields.traceId;
  if (typeof traceId === "string" && traceId.length > 0) {
    const spanId = fields.spanId;
    const span = typeof spanId === "string" ? spanId : "";
    return `${traceId}:${span}`;
  }
  return undefined;
}

/**
 * Consult the live op-control kill switch before the gateway is queried.
 *
 * A terminated op throws {@link PolicyViolationError} so the tool is blocked
 * (and the gateway is never reached — the kill switch short-circuits). A paused
 * op blocks here in `waitForOp` until the gateway resumes (or terminates) it.
 * A no-op when no subscriber is wired or the call carries no `opId`.
 *
 * @throws {PolicyViolationError} when the op has been terminated by the gateway.
 */
async function enforceOpControl(
  opControl: OpControl | undefined,
  name: string,
  args: unknown[]
): Promise<void> {
  if (!opControl) {
    return;
  }
  const opId = extractOpId(args);
  if (!opId) {
    return;
  }
  try {
    await opControl.waitForOp(opId);
  } catch (error) {
    if (error instanceof OpTerminatedError) {
      throw new PolicyViolationError(`Tool '${name}' terminated: ${error.message}`);
    }
    throw error;
  }
}

async function waitForApprovalWithTimeout(
  gateway: GatewayClient,
  toolName: string,
  runId: string,
  timeoutMs: number
): Promise<{ denied?: boolean; reason?: string }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<{ denied: true; reason: string }>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ denied: true, reason: `Approval timeout after ${timeoutMs}ms` });
    }, timeoutMs);
  });

  try {
    const approvalPromise = gateway.waitForApproval(toolName, runId, timeoutMs);
    return await Promise.race([approvalPromise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function hasExecute(
  tool: Record<string, unknown>
): tool is Record<string, unknown> & { execute: (...args: unknown[]) => unknown } {
  return typeof tool.execute === "function";
}

function hasInvoke(
  tool: Record<string, unknown>
): tool is Record<string, unknown> & { invoke: (...args: unknown[]) => unknown } {
  return typeof tool.invoke === "function";
}

/**
 * Hand a pre-execution deny to the gateway's audit sink (AAASM-5665).
 *
 * Before this, `withAssembly` called `check` and never `record`, so a denied
 * call produced no audit event at all — the thrown `PolicyViolationError` was
 * the only trace, and it never leaves the process.
 *
 * `GatewayRecordEvent` carries no tool-name field and adding one is a wire
 * change, so the tool is named inside `reason` — reusing the thrown error's own
 * message, so the audit event and the error a caller sees cannot drift apart.
 *
 * **Every failure mode is swallowed, synchronous throws included.** A failing
 * audit sink must not convert a policy deny into some other error: the throw
 * that follows this call is the enforcement decision and has to survive. The
 * `try`/`catch` is load-bearing rather than stylistic — `gatewayClient` is a
 * documented public injection point, so a caller-supplied `record` that throws
 * synchronously never produces a promise for a trailing `.catch()` to attach
 * to, and would escape past the `PolicyViolationError`. Mirrors the Python
 * companion's `try/except Exception` around the same hook (AAASM-4782).
 *
 * This is deliberately awaited, unlike the `void ... .catch()` in
 * `recordToolResultNonBlocking` (`hooks/ai-sdk.ts`, `hooks/openai-agents.ts`):
 * the event is handed over before the deny is thrown, so it cannot be lost if
 * the caller exits on the error. The cost is that a `record` which hangs delays
 * the deny — there is no timeout here, unlike `waitForApprovalWithTimeout`.
 *
 * Whether the deny becomes observable depends on the client underneath. Over a
 * loaded native binding `createNativeGatewayClient` sends the event to the
 * runtime's audit pipeline, which under ADR 0033 §6 is *Observed*;
 * `createNoopGatewayClient` holds no transport and drops it, leaving the deny
 * with no audit evidence at all (AAASM-5750). `initAssembly` warns in the
 * second case and reports which one a run is in as `context.auditSink`.
 */
async function recordDeny(
  gateway: GatewayClient,
  action: string,
  runId: string,
  reason: string
): Promise<void> {
  try {
    await gateway.record({ action, runId, reason });
  } catch {
    // Intentionally ignored — see the note above on why the deny must survive.
  }
}

/**
 * Run the full pre-execution governance chain for one wrapped tool call.
 *
 * Order is load-bearing: the live op-control kill switch (AAASM-3491) runs
 * first so an operator terminate short-circuits *before* the gateway is queried
 * and a pause blocks here until resume; only then does the pre-exec gateway
 * check + approval flow run.
 *
 * @throws {PolicyViolationError} when the op is terminated, the gateway denies,
 *   or an approval is rejected / times out.
 */
async function enforceGovernance(
  name: string,
  args: unknown[],
  gateway: GatewayClient,
  opControl: OpControl | undefined,
  approvalTimeoutMs: number
): Promise<void> {
  await enforceOpControl(opControl, name, args);

  const runId = `run_${randomUUID()}`;
  const decision = await gateway.check({
    action: "tool_call",
    toolName: name,
    args,
    runId
  });

  // Both refusal routes converge on a single record-then-throw below rather
  // than each carrying its own copy (AAASM-5665). Two call sites is an
  // invitation to fix one and miss the other — which is exactly what happened
  // in review: the approval-rejected copy could be deleted outright with the
  // whole suite still green. One site cannot drift from itself.
  let denial: { action: string; error: PolicyViolationError } | undefined;

  if (decision.denied) {
    denial = {
      action: "tool_call_denied",
      error: new PolicyViolationError(`Tool '${name}' blocked: ${decision.reason ?? "Denied"}`)
    };
  } else if (decision.pending) {
    const finalDecision = await waitForApprovalWithTimeout(gateway, name, runId, approvalTimeoutMs);
    if (finalDecision.denied) {
      denial = {
        action: "tool_call_approval_rejected",
        error: new PolicyViolationError(
          `Approval rejected for '${name}': ${finalDecision.reason ?? "Rejected"}`
        )
      };
    }
  }

  if (denial) {
    await recordDeny(gateway, denial.action, runId, denial.error.message);
    throw denial.error;
  }
}

/**
 * Loud, un-silenceable signal that a tool's call seam (`execute`/`invoke`) is
 * non-writable/frozen so `withAssembly` could not wrap it. Written straight to
 * `process.stderr` (not a swappable logger) so an operator can't be left
 * believing an unwrappable tool is governed — a policy DENY will NOT block its
 * calls (AAASM-4852).
 */
function warnToolSeamNotWritable(name: string, seam: "execute" | "invoke"): void {
  process.stderr.write(
    `[agent-assembly] WARNING: tool "${name}" has a non-writable/frozen ` +
      `\`${seam}\` — withAssembly could not wrap it, so this tool will NOT be ` +
      `governed: a policy DENY will NOT block its calls. Avoid freezing tool ` +
      `objects passed to withAssembly (AAASM-4852).\n`
  );
}

function wrapSingleTool(
  name: string,
  tool: Record<string, unknown>,
  gateway: GatewayClient,
  options: WithAssemblyOptions
): void {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const opControl = options.opControl;

  if (hasExecute(tool)) {
    // A frozen / read-only tool object makes the seam assignment below throw in
    // strict mode. Because `withAssembly` iterates the tool map, an unguarded
    // throw would abort mid-map after already mutating earlier tools, leaving a
    // partial governed/ungoverned state. Skip + warn so the rest of the map
    // stays governed and no tool is half-applied (AAASM-4852, mirroring
    // AAASM-4847).
    if (!isSeamWritable(tool, "execute")) {
      warnToolSeamNotWritable(name, "execute");
      return;
    }
    const originalExecute = tool.execute;
    tool.execute = async (...args: unknown[]) => {
      await enforceGovernance(name, args, gateway, opControl, approvalTimeoutMs);
      return originalExecute(...args);
    };
  } else if (hasInvoke(tool)) {
    if (!isSeamWritable(tool, "invoke")) {
      warnToolSeamNotWritable(name, "invoke");
      return;
    }
    const originalInvoke = tool.invoke;
    tool.invoke = async (...args: unknown[]) => {
      await enforceGovernance(name, args, gateway, opControl, approvalTimeoutMs);
      return originalInvoke(...args);
    };
  } else {
    // A tool exposing neither `execute` nor `invoke` has no call seam to wrap,
    // so it would pass through withAssembly ungoverned. Silently skipping it
    // (the prior behavior) hides that gap: the caller believes every tool in
    // the map is governed. Warn loudly on stderr so an ungoverned tool is an
    // explicit, visible outcome rather than a silent one (AAASM-4847).
    process.stderr.write(
      `[agent-assembly] WARNING: tool "${name}" exposes neither \`execute\` nor ` +
        `\`invoke\` — withAssembly has no call seam to wrap, so this tool will ` +
        `NOT be governed: a policy DENY will NOT block its calls (AAASM-4847).\n`
    );
  }
}

export function withAssembly<TTool, TTools extends ToolMap<TTool>>(
  tools: TTools,
  options: WithAssemblyOptions
): TTools {
  for (const [name, tool] of Object.entries(tools)) {
    wrapSingleTool(name, tool as Record<string, unknown>, options.gatewayClient, options);
  }
  return tools;
}
