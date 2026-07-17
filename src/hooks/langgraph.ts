import { runWithAgentId } from "../lineage/agent-context-store.js";
import { redactErrorMessage } from "../core/redact.js";

export interface CompiledGraph {
  invoke: (...args: unknown[]) => Promise<unknown>;
  stream: (...args: unknown[]) => Promise<unknown>;
}

export interface StateGraphClass {
  prototype: {
    compile?: (...args: unknown[]) => CompiledGraph;
  };
}

export interface LangGraphModule {
  StateGraph: StateGraphClass;
}

export interface LangGraphPatchState {
  isPatched: boolean;
  originalCompile: ((...args: unknown[]) => CompiledGraph) | undefined;
  patchedClass: StateGraphClass | undefined;
}

export const langGraphPatchState: LangGraphPatchState = {
  isPatched: false,
  originalCompile: undefined,
  patchedClass: undefined
};

export function wrapCompiledGraph(compiled: CompiledGraph, agentId: string): CompiledGraph {
  const originalInvoke = compiled.invoke.bind(compiled);
  const originalStream = compiled.stream.bind(compiled);

  compiled.invoke = (...args: unknown[]) =>
    runWithAgentId(agentId, () => originalInvoke(...args));

  compiled.stream = (...args: unknown[]) =>
    runWithAgentId(agentId, () => originalStream(...args));

  return compiled;
}

export interface PatchLangGraphOptions {
  agentId: string;
  loadModule?: () => Promise<LangGraphModule | undefined>;
}

async function loadLangGraphModule(): Promise<LangGraphModule | undefined> {
  try {
    const moduleName = "@langchain/langgraph";
    const module = (await import(moduleName)) as LangGraphModule;
    return module;
  } catch {
    return undefined;
  }
}

export async function patchLangGraph(options: PatchLangGraphOptions): Promise<boolean> {
  if (langGraphPatchState.isPatched) {
    return true;
  }

  const loadModule = options.loadModule ?? loadLangGraphModule;
  let module: LangGraphModule | undefined;
  try {
    module = await loadModule();
  } catch {
    return false;
  }

  if (!module?.StateGraph?.prototype?.compile) {
    return false;
  }

  const originalCompile = module.StateGraph.prototype.compile;
  langGraphPatchState.originalCompile = originalCompile;
  langGraphPatchState.patchedClass = module.StateGraph;

  const { agentId } = options;
  module.StateGraph.prototype.compile = function patchedCompile(
    ...args: unknown[]
  ): CompiledGraph {
    const compiled = originalCompile.apply(this, args);

    try {
      return wrapCompiledGraph(compiled, agentId);
    } catch (e) {
      console.warn(
        "[assembly] LangGraph lineage patch error on compile; falling back:",
        redactErrorMessage(e)
      );
      return compiled;
    }
  };

  langGraphPatchState.isPatched = true;
  return true;
}

export function unpatchLangGraph(): boolean {
  if (!langGraphPatchState.isPatched) {
    return false;
  }
  if (!langGraphPatchState.patchedClass || !langGraphPatchState.originalCompile) {
    return false;
  }

  langGraphPatchState.patchedClass.prototype.compile = langGraphPatchState.originalCompile;
  langGraphPatchState.isPatched = false;
  langGraphPatchState.originalCompile = undefined;
  langGraphPatchState.patchedClass = undefined;
  return true;
}
