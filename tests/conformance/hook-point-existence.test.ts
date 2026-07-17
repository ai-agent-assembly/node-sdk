/**
 * Hook-point-existence smoke tests (AAASM-4801, would have caught AAASM-4797).
 *
 * Every integration that monkey-patches an upstream API depends on a specific
 * upstream symbol still existing. AAASM-4797 slipped precisely because
 * `@openai/agents` silently removed `Agent.prototype._runTool` and the patch
 * found nothing to hook — with no test asserting the symbol was there. These
 * tests fail LOUD the moment an installed upstream release moves or renames the
 * symbol the corresponding patch wraps, turning a silent production ungoverning
 * into a red build.
 *
 * Scope: only the upstreams actually installed here (`@openai/agents`, `ai`,
 * `@langchain/core`) — the enforcement integrations. The lineage-only patches
 * (`@langchain/langgraph`, `@mastra/core`) are not installed and do not gate
 * tool calls, so they are out of scope for this suite.
 */
import { describe, expect, it } from "vitest";
import { Agent } from "@openai/agents";
import * as vercelAi from "ai";
import { tool as langchainTool } from "@langchain/core/tools";

describe("hook-point existence smoke tests (AAASM-4801)", () => {
  it("openai-agents: Agent.prototype.getAllTools exists (patchOpenAIAgents hook point)", () => {
    // The >= 0.8.x hook point patchViaGetAllTools wraps. If a future release
    // moves it the way 0.8.x removed _runTool, this fails here, not in prod.
    expect(typeof Agent.prototype.getAllTools).toBe("function");
  });

  it("vercel-ai: `tool` export is a function (patchVercelAiSdk wraps this factory)", () => {
    // captureOriginalToolFactory reads `module.tool`; a non-function means the
    // patch silently captures nothing and installs no governance.
    expect(typeof vercelAi.tool).toBe("function");
  });

  it("langchain: a built tool exposes an `invoke` method (wrapToolWithAssembly hook point)", () => {
    // wrapToolWithAssembly rebinds `tool.invoke`; if LangChain renames the tool
    // execution method this fails here rather than leaving tools ungoverned.
    const built = langchainTool(async () => "ok", {
      name: "smoke_probe",
      description: "hook-point smoke probe"
    });
    expect(typeof (built as { invoke?: unknown }).invoke).toBe("function");
  });
});
