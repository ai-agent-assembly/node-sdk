/**
 * Public re-exports for the per-framework governance patch hooks
 * (AAASM-2922).
 *
 * These let consumers apply a single framework's governance hook manually,
 * instead of relying on `initAssembly()` to patch every detected framework.
 * Only the user-facing patch/unpatch/has surface and the option/module
 * interfaces those functions take as parameters are re-exported here;
 * internal helpers (wrappers, patch-state, capture/record utilities) stay
 * private to their hook modules.
 */

// Vercel AI SDK
export { patchVercelAiSdk, unpatchVercelAiSdk } from "./ai-sdk.js";
export type { PatchVercelAiSdkOptions, VercelAiSdkModule } from "./ai-sdk.js";
export { hasVercelAiSdk } from "./ai-sdk-detection.js";

// LangGraph
export { patchLangGraph, unpatchLangGraph } from "./langgraph.js";
export type { PatchLangGraphOptions, LangGraphModule } from "./langgraph.js";
export { hasLangGraph } from "./langgraph-detection.js";

// Mastra
export { patchMastra, unpatchMastra } from "./mastra.js";
export type { PatchMastraOptions, MastraModule } from "./mastra.js";
export { hasMastra } from "./mastra-detection.js";

// LangChain
export { patchLangChain } from "./langchain.js";

// OpenAI Agents
export { patchOpenAIAgents, unpatchOpenAIAgents } from "./openai-agents.js";
export type { PatchOpenAIAgentsOptions } from "./openai-agents.js";
export { hasOpenAIAgentsSDK } from "./openai-agents-detection.js";
