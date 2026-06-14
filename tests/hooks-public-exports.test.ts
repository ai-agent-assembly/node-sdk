/**
 * Public-API surface tests for the per-framework patch hooks (AAASM-2922).
 *
 * These hooks were previously internal to src/core/init-assembly.ts. This
 * suite asserts that the curated patch/unpatch/has surface is reachable from
 * the package entry point (`../src/index.js`) so consumers can apply a single
 * framework's governance hook manually, and that internal helpers are NOT
 * leaked through the public barrel.
 */

import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import * as hooks from "../src/hooks/index.js";

describe("public framework hook exports", () => {
  const publicSymbols = [
    "patchVercelAiSdk",
    "unpatchVercelAiSdk",
    "patchLangGraph",
    "unpatchLangGraph",
    "patchMastra",
    "unpatchMastra",
    "patchLangChain",
    "patchOpenAIAgents",
    "unpatchOpenAIAgents",
    "hasVercelAiSdk",
    "hasLangGraph",
    "hasMastra",
    "hasOpenAIAgentsSDK"
  ] as const;

  it.each(publicSymbols)("exposes %s as a function from the package entry", (name) => {
    expect(typeof (sdk as Record<string, unknown>)[name]).toBe("function");
  });

  it.each(publicSymbols)("exposes %s from the ./hooks barrel", (name) => {
    expect(typeof (hooks as Record<string, unknown>)[name]).toBe("function");
  });

  const internalHelpers = [
    "createWrappedExecute",
    "createPatchedToolFactory",
    "captureOriginalToolFactory",
    "recordToolResultNonBlocking",
    "wrapCompiledGraph",
    "parseToolCallArguments",
    "vercelAiSdkPatchState",
    "langGraphPatchState",
    "mastraPatchState",
    "openAIAgentsPatchState"
  ] as const;

  it.each(internalHelpers)("does not leak internal helper %s through the barrel", (name) => {
    expect((hooks as Record<string, unknown>)[name]).toBeUndefined();
  });
});
