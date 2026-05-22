import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __testing, DEFAULT_GATEWAY_URL, ENV_API_KEY, ENV_GATEWAY_URL } from "../src/core/gateway-resolver.js";
import { initAssembly } from "../src/index.js";

describe("initAssembly zero-config", () => {
  const originalSeams = { ...__testing._seams };
  const originalGatewayEnv = process.env[ENV_GATEWAY_URL];
  const originalApiKeyEnv = process.env[ENV_API_KEY];

  beforeEach(() => {
    delete process.env[ENV_GATEWAY_URL];
    delete process.env[ENV_API_KEY];
  });

  afterEach(async () => {
    Object.assign(__testing._seams, originalSeams);
    if (originalGatewayEnv === undefined) delete process.env[ENV_GATEWAY_URL];
    else process.env[ENV_GATEWAY_URL] = originalGatewayEnv;
    if (originalApiKeyEnv === undefined) delete process.env[ENV_API_KEY];
    else process.env[ENV_API_KEY] = originalApiKeyEnv;
    vi.restoreAllMocks();
  });

  it("AAASM-1847 AC: initAssembly() with no args resolves the local default", async () => {
    __testing._seams.loadConfigFile = async () => ({});
    __testing._seams.probeHealthz = async () => true;
    __testing._seams.autoStartGateway = vi.fn();

    const ctx = await initAssembly();
    try {
      expect(ctx).toBeDefined();
      expect(Array.isArray(ctx.activeAdapters)).toBe(true);
    } finally {
      await ctx.shutdown();
    }

    expect(__testing._seams.autoStartGateway).not.toHaveBeenCalled();
  });

  it("triggers auto-start when no gateway is listening", async () => {
    __testing._seams.loadConfigFile = async () => ({});
    __testing._seams.probeHealthz = async () => false;
    const autoStartSpy = vi.fn().mockResolvedValue(undefined);
    __testing._seams.autoStartGateway = autoStartSpy;

    const ctx = await initAssembly();
    try {
      expect(autoStartSpy).toHaveBeenCalledWith(DEFAULT_GATEWAY_URL);
    } finally {
      await ctx.shutdown();
    }
  });

  it("explicit gatewayUrl + apiKey bypass the resolver entirely", async () => {
    const probeSpy = vi.fn().mockImplementation(() => {
      throw new Error("resolver should not probe when explicit args provided");
    });
    const autoStartSpy = vi.fn().mockImplementation(() => {
      throw new Error("resolver should not auto-start when explicit args provided");
    });
    __testing._seams.probeHealthz = probeSpy;
    __testing._seams.autoStartGateway = autoStartSpy;

    const ctx = await initAssembly({
      gatewayUrl: "http://explicit.gw:9999",
      apiKey: "explicit-key"
    });
    try {
      expect(probeSpy).not.toHaveBeenCalled();
      expect(autoStartSpy).not.toHaveBeenCalled();
    } finally {
      await ctx.shutdown();
    }
  });
});
