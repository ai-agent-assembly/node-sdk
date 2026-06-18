import { runWithAgentId } from "../lineage/agent-context-store.js";

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
}

export const mastraPatchState: MastraPatchState = {
  isPatched: false,
  originalGenerate: undefined,
  originalExecute: undefined,
  patchedAgentClass: undefined,
  patchedWorkflowClass: undefined
};

export interface PatchMastraOptions {
  agentId: string;
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

export async function patchMastra(options: PatchMastraOptions): Promise<boolean> {
  if (mastraPatchState.isPatched) {
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
      console.warn("[assembly] Mastra lineage patch error on generate; falling back:", e);
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
        console.warn("[assembly] Mastra lineage patch error on execute; falling back:", e);
        return originalExecute.apply(this, args);
      }
    };
  }

  mastraPatchState.isPatched = true;
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
  return true;
}
