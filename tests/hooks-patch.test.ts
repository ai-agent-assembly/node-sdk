import { describe, expect, it, vi } from "vitest";
import { patchVercelAiSdk } from "../src/hooks/ai-sdk.js";
import { patchLangChain } from "../src/hooks/langchain.js";
import type { NativeClient } from "../src/native/client.js";
import type { GatewayClient } from "../src/gateway/client.js";

function createClient(mode: NativeClient["mode"]): NativeClient {
  return {
    mode,
    close: async () => undefined,
    sendEvent: () => undefined,
    queryPolicy: async () => ({ denied: false, pending: false }),
    register: async () => ""
  };
}

function createGatewayClientMock(): GatewayClient {
  return {
    mode: "sdk-only",
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    check: vi.fn(async () => ({ denied: false, pending: false })),
    waitForApproval: vi.fn(async () => ({ denied: false })),
    record: vi.fn(async () => undefined),
    recordResult: vi.fn(async () => undefined),
    scanPrompts: vi.fn(async () => undefined)
  };
}

describe("framework patch hooks", () => {
  it("patchLangChain returns false for native modes while patching is not implemented", async () => {
    await expect(patchLangChain(createClient("grpc-sidecar"))).resolves.toBe(false);
    await expect(patchLangChain(createClient("napi-inprocess"))).resolves.toBe(false);
  });

  it("patchVercelAiSdk returns false when module cannot be loaded", async () => {
    const gateway = createGatewayClientMock();
    await expect(
      patchVercelAiSdk({
        gatewayClient: gateway,
        loadModule: async () => undefined
      })
    ).resolves.toBe(false);
  });
});
