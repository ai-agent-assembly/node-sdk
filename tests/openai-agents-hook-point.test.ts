import { describe, expect, it } from "vitest";
import { Agent } from "@openai/agents";

/**
 * Hook-point existence smoke test (AAASM-4797).
 *
 * `patchOpenAIAgents` attaches governance by wrapping `Agent.prototype.getAllTools`
 * on `@openai/agents` >= 0.8.x. If a future upstream release moves or renames
 * that method the way 0.8.x removed `_runTool`, the patch would silently attach
 * to nothing again — the exact regression this ticket fixes. This test fails
 * immediately when the hook symbol the patch depends on disappears from the
 * *installed* package, so the API move is caught here rather than in production.
 */
describe("openai agents hook point", () => {
  it("exposes Agent.prototype.getAllTools on the installed @openai/agents", () => {
    expect(typeof Agent.prototype.getAllTools).toBe("function");
  });
});
