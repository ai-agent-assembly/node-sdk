import { runWithAgentId } from "../lineage/agent-context-store.js";
import { redactErrorMessage } from "../core/redact.js";

export interface MastraAgentClass {
  prototype: {
    generate?: (...args: unknown[]) => Promise<unknown>;
  };
}

export interface MastraWorkflowClass {
  prototype: {
    execute?: (...args: unknown[]) => Promise<unknown>;
  };
}

export interface MastraModule {
  Agent: MastraAgentClass;
  Workflow?: MastraWorkflowClass;
}

export interface MastraPatchState {
  isPatched: boolean;
  originalGenerate: ((...args: unknown[]) => Promise<unknown>) | undefined;
  originalExecute: ((...args: unknown[]) => Promise<unknown>) | undefined;
  patchedAgentClass: MastraAgentClass | undefined;
  patchedWorkflowClass: MastraWorkflowClass | undefined;
  /**
   * The `agentId` the FIRST successful patch ran under, so a later re-patch
   * attempt (single patch per process) can detect a differing config and warn
   * rather than silently keep tagging lineage with the stale id (AAASM-4830).
   */
  patchConfigSignature: string | undefined;
}

export const mastraPatchState: MastraPatchState = {
  isPatched: false,
  originalGenerate: undefined,
  originalExecute: undefined,
  patchedAgentClass: undefined,
  patchedWorkflowClass: undefined,
  patchConfigSignature: undefined
};

export interface PatchMastraOptions {
  agentId: string;
  /**
   * The caller's resolved fail-closed (enforce) posture. When true and the
   * patch takes effect, a one-time note is emitted clarifying that Mastra is
   * lineage-only — this SDK performs NO in-process tool-governance check for it,
   * so an operator under enforce isn't misled into assuming DENY blocks a Mastra
   * tool call in-process (AAASM-4830).
   */
  failClosed?: boolean;
  loadModule?: () => Promise<MastraModule | undefined>;
}

async function loadMastraModule(): Promise<MastraModule | undefined> {
  try {
    const moduleName = "@mastra/core";
    const module = (await import(moduleName)) as MastraModule;
    return module;
  } catch {
    return undefined;
  }
}

/**
 * Loud, un-silenceable signal that a second `initAssembly` tried to re-patch
 * Mastra with a DIFFERENT `agentId` while an earlier patch is installed. The
 * singleton early return keeps the FIRST patch in effect, so lineage keeps being
 * tagged with the first `agentId` — the new one silently does NOT take effect.
 * Written straight to `process.stderr` so an operator can't be misled (AAASM-4830).
 */
function warnMastraRepatchIgnored(): void {
  process.stderr.write(
    `[agent-assembly] WARNING: @mastra/core is already patched by an earlier ` +
      `initAssembly with a different agentId. Lineage tagging is a single patch ` +
      `per process, so the FIRST agentId stays in effect — this re-init did NOT ` +
      `change it. Restart the process to apply a new configuration (AAASM-4830).\n`
  );
}

/**
 * One-time note that Mastra is a lineage-only integration: this SDK tags
 * parent→child agent context on `Agent.generate` / `Workflow.execute` but
 * performs NO in-process tool-governance check (it is in
 * `NON_ENFORCING_MODULES`). Emitted only under an enforce posture so an operator
 * who expects blocking isn't misled into assuming a policy DENY blocks a Mastra
 * tool call in-process — network egress stays governed by the sidecar proxy and
 * eBPF layers, which are authoritative (AAASM-4830). Written straight to
 * `process.stderr`.
 */
function noteMastraLineageOnlyUnderEnforce(): void {
  process.stderr.write(
    `[agent-assembly] NOTE: Mastra was auto-detected under an enforce posture, but ` +
      `this SDK applies only lineage tagging (parent→child agent context) to Mastra ` +
      `Agent/Workflow calls — it performs NO in-process tool-governance check, so a ` +
      `policy DENY will NOT block a Mastra tool call in-process. Network egress ` +
      `remains governed by the sidecar proxy and eBPF layers, which are ` +
      `authoritative (AAASM-4830).\n`
  );
}

export async function patchMastra(options: PatchMastraOptions): Promise<boolean> {
  if (mastraPatchState.isPatched) {
    // Single patch per process (the patch mutates the shared Agent/Workflow
    // prototypes): the early return keeps the first agentId. Warn loudly if this
    // re-init carries a different agentId so the change isn't silently ignored.
    if (
      mastraPatchState.patchConfigSignature !== undefined &&
      mastraPatchState.patchConfigSignature !== options.agentId
    ) {
      warnMastraRepatchIgnored();
    }
    return true;
  }

  const loadModule = options.loadModule ?? loadMastraModule;
  let module: MastraModule | undefined;
  try {
    module = await loadModule();
  } catch {
    return false;
  }

  if (!module?.Agent?.prototype?.generate) {
    return false;
  }

  const { agentId } = options;

  // Wrap Agent.prototype.generate
  const originalGenerate = module.Agent.prototype.generate;
  mastraPatchState.originalGenerate = originalGenerate;
  mastraPatchState.patchedAgentClass = module.Agent;

  module.Agent.prototype.generate = function patchedGenerate(
    ...args: unknown[]
  ): Promise<unknown> {
    // The try guards only the *synchronous* setup (entering the async-context
    // store and invoking the original); the returned promise is handed to the
    // caller, which awaits it, so its rejection is the caller's to handle.
    // Returning it directly (rather than via a local inside the try) avoids an
    // unhandled-rejection footgun without changing timing or call count.
    try {
      return runWithAgentId(agentId, () => originalGenerate.apply(this, args));
    } catch (e) {
      console.warn(
        "[assembly] Mastra lineage patch error on generate; falling back:",
        redactErrorMessage(e)
      );
      return originalGenerate.apply(this, args);
    }
  };

  // Wrap Workflow.prototype.execute if present
  if (module.Workflow?.prototype?.execute) {
    const originalExecute = module.Workflow.prototype.execute;
    mastraPatchState.originalExecute = originalExecute;
    mastraPatchState.patchedWorkflowClass = module.Workflow;

    module.Workflow.prototype.execute = function patchedExecute(
      ...args: unknown[]
    ): Promise<unknown> {
      // See patchedGenerate above: the try guards only the synchronous setup;
      // the returned promise is awaited by the caller, so returning it directly
      // (not via a local) handles its rejection without altering behaviour.
      try {
        return runWithAgentId(agentId, () => originalExecute.apply(this, args));
      } catch (e) {
        console.warn(
          "[assembly] Mastra lineage patch error on execute; falling back:",
          redactErrorMessage(e)
        );
        return originalExecute.apply(this, args);
      }
    };
  }

  mastraPatchState.isPatched = true;
  mastraPatchState.patchConfigSignature = agentId;

  if (options.failClosed) {
    noteMastraLineageOnlyUnderEnforce();
  }
  return true;
}

export function unpatchMastra(): boolean {
  if (!mastraPatchState.isPatched) {
    return false;
  }

  if (mastraPatchState.patchedAgentClass && mastraPatchState.originalGenerate) {
    mastraPatchState.patchedAgentClass.prototype.generate = mastraPatchState.originalGenerate;
  }
  if (mastraPatchState.patchedWorkflowClass && mastraPatchState.originalExecute) {
    mastraPatchState.patchedWorkflowClass.prototype.execute = mastraPatchState.originalExecute;
  }

  mastraPatchState.isPatched = false;
  mastraPatchState.originalGenerate = undefined;
  mastraPatchState.originalExecute = undefined;
  mastraPatchState.patchedAgentClass = undefined;
  mastraPatchState.patchedWorkflowClass = undefined;
  mastraPatchState.patchConfigSignature = undefined;
  return true;
}
