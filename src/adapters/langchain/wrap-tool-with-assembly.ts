import { randomUUID } from "node:crypto";
import { isSeamWritable } from "../../core/tool-seam-guard.js";
import { PolicyViolationError } from "../../errors/policy-violation-error.js";
import type { GatewayClient } from "../../gateway/client.js";
import type { LangChainRunConfig, LangChainToolLike } from "../../types/langchain-adapter.js";

export interface WrapToolWithAssemblyOptions {
  approvalTimeoutMs?: number;
  generateRunId?: () => string;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

function createRunId(): string {
  return `run_${randomUUID()}`;
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

/**
 * Loud, un-silenceable signal that a specific LangChain tool could not be
 * wrapped because its `invoke` slot is non-writable/frozen. The wrapper layer is
 * LangChain's ONLY blocking enforcement point (the callback handler is
 * audit-only, AAASM-4799), so an unwrappable tool runs with NO pre-execution
 * deny. Written straight to `process.stderr` (not a swappable logger) so an
 * operator can't be left unaware (AAASM-4852).
 */
function warnLangChainToolNotWrappable(toolName: string): void {
  process.stderr.write(
    `[agent-assembly] WARNING: the LangChain tool "${toolName}" has a ` +
      `non-writable/frozen \`invoke\` and could not be wrapped for governance — ` +
      `this tool's calls will NOT be governed by this SDK: a policy DENY will NOT ` +
      `block them (the LangChain callback handler is audit-only). Avoid freezing ` +
      `tool objects passed to a governed agent (AAASM-4852).\n`
  );
}

export function wrapToolWithAssembly<TTool extends LangChainToolLike>(
  tool: TTool,
  gateway: GatewayClient,
  options: WrapToolWithAssemblyOptions = {}
): TTool {
  // A frozen / read-only tool object makes the `tool.invoke = …` assignment
  // below throw in strict mode. Because `wrapLangChainTools` calls this in a
  // loop with no per-tool try/catch, an unguarded throw would abort wrapping of
  // every remaining tool and propagate out of `initAssembly` — a worse failure
  // than the one ungoverned tool. Skip + warn instead so the rest stay governed
  // and the loop stays resilient (AAASM-4852, mirroring AAASM-4847).
  if (!isSeamWritable(tool, "invoke")) {
    warnLangChainToolNotWrappable(tool.name);
    return tool;
  }

  const originalInvoke = tool.invoke.bind(tool);
  const generateRunId = options.generateRunId ?? createRunId;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  tool.invoke = async (input: unknown, config?: LangChainRunConfig) => {
    const runId = getRunId(config, generateRunId);
    const decision = await gateway.check({
      action: "tool_call",
      toolName: tool.name,
      args: input,
      runId
    });

    if (decision.denied) {
      throw new PolicyViolationError(`Tool '${tool.name}' blocked: ${decision.reason ?? "Denied"}`);
    }

    if (decision.pending) {
      const finalDecision = await waitForApprovalWithTimeout(
        gateway,
        tool.name,
        runId,
        approvalTimeoutMs
      );
      if (finalDecision.denied) {
        throw new PolicyViolationError(
          `Approval rejected for '${tool.name}': ${finalDecision.reason ?? "Rejected"}`
        );
      }
    }

    return originalInvoke(input, config ? { ...config, runId } : { runId });
  };

  return tool;
}

export function getRunId(config: LangChainRunConfig | undefined, generateRunId: () => string): string {
  return config?.runId ?? generateRunId();
}
