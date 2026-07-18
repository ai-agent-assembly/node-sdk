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
  /**
   * The `agentId` the FIRST successful patch ran under, so a later re-patch
   * attempt (single patch per process) can detect a differing config and warn
   * rather than silently keep tagging lineage with the stale id (AAASM-4830).
   */
  patchConfigSignature: string | undefined;
}

export const langGraphPatchState: LangGraphPatchState = {
  isPatched: false,
  originalCompile: undefined,
  patchedClass: undefined,
  patchConfigSignature: undefined
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
  /**
   * The caller's resolved fail-closed (enforce) posture. When true and the
   * patch takes effect, a one-time note is emitted clarifying that LangGraph is
   * lineage-only — this SDK performs NO in-process tool-governance check for it,
   * so an operator under enforce isn't misled into assuming DENY blocks a
   * LangGraph tool call in-process (AAASM-4830).
   */
  failClosed?: boolean;
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

/**
 * Loud, un-silenceable signal that a second `initAssembly` tried to re-patch
 * LangGraph with a DIFFERENT `agentId` while an earlier patch is installed. The
 * singleton early return keeps the FIRST patch in effect, so lineage keeps being
 * tagged with the first `agentId` — the new one silently does NOT take effect.
 * Written straight to `process.stderr` so an operator can't be misled (AAASM-4830).
 */
function warnLangGraphRepatchIgnored(): void {
  process.stderr.write(
    `[agent-assembly] WARNING: @langchain/langgraph is already patched by an ` +
      `earlier initAssembly with a different agentId. Lineage tagging is a single ` +
      `patch per process, so the FIRST agentId stays in effect — this re-init did ` +
      `NOT change it. Restart the process to apply a new configuration (AAASM-4830).\n`
  );
}

/**
 * One-time note that LangGraph is a lineage-only integration: this SDK tags
 * parent→child agent context on `StateGraph` invoke/stream but performs NO
 * in-process tool-governance check (it is in `NON_ENFORCING_MODULES`). Emitted
 * only under an enforce posture so an operator who expects blocking isn't misled
 * into assuming a policy DENY blocks a LangGraph tool call in-process — network
 * egress stays governed by the sidecar proxy and eBPF layers, which are
 * authoritative (AAASM-4830). Written straight to `process.stderr`.
 */
function noteLangGraphLineageOnlyUnderEnforce(): void {
  process.stderr.write(
    `[agent-assembly] NOTE: LangGraph was auto-detected under an enforce posture, ` +
      `but this SDK applies only lineage tagging (parent→child agent context) to ` +
      `LangGraph StateGraph invoke/stream calls — it performs NO in-process ` +
      `tool-governance check, so a policy DENY will NOT block a LangGraph tool call ` +
      `in-process. Network egress remains governed by the sidecar proxy and eBPF ` +
      `layers, which are authoritative (AAASM-4830).\n`
  );
}

export async function patchLangGraph(options: PatchLangGraphOptions): Promise<boolean> {
  if (langGraphPatchState.isPatched) {
    // Single patch per process (the patch mutates the shared StateGraph
    // prototype): the early return keeps the first agentId. Warn loudly if this
    // re-init carries a different agentId so the change isn't silently ignored.
    if (
      langGraphPatchState.patchConfigSignature !== undefined &&
      langGraphPatchState.patchConfigSignature !== options.agentId
    ) {
      warnLangGraphRepatchIgnored();
    }
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
  langGraphPatchState.patchConfigSignature = agentId;

  if (options.failClosed) {
    noteLangGraphLineageOnlyUnderEnforce();
  }
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
  langGraphPatchState.patchConfigSignature = undefined;
  return true;
}
