import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gatewayClientModule from "../src/gateway/client.js";
import { createNoopGatewayClient } from "../src/gateway/client.js";
import { createClient } from "../src/core/init-assembly.js";
import {
  ENV_CONTROL_PLANE_URL,
  ENV_GATEWAY_URL,
  initAssembly
} from "../src/core/init-assembly.js";
import { __testing } from "../src/core/gateway-resolver.js";

describe("createNoopGatewayClient httpBaseUrl", () => {
  it("exposes the supplied httpBaseUrl", () => {
    const client = createNoopGatewayClient("sdk-only", "https://cp.example.com");
    expect(client.httpBaseUrl).toBe("https://cp.example.com");
  });

  it("leaves httpBaseUrl undefined when no URL is supplied", () => {
    const client = createNoopGatewayClient("sdk-only");
    expect(client.httpBaseUrl).toBeUndefined();
  });
});

describe("createClient HTTP base URL resolution", () => {
  it("defaults the HTTP base URL to gatewayUrl when controlPlaneUrl is unset", () => {
    const client = createClient({ gatewayUrl: "https://gateway.example.com" });
    expect(client.httpBaseUrl).toBe("https://gateway.example.com");
  });

  it("uses controlPlaneUrl for the HTTP base URL when set", () => {
    const client = createClient({
      gatewayUrl: "https://gateway.example.com",
      controlPlaneUrl: "https://control-plane.example.com"
    });
    expect(client.httpBaseUrl).toBe("https://control-plane.example.com");
  });

  it("returns an explicit gatewayClient unchanged", () => {
    const injected = createNoopGatewayClient("sdk-only", "https://injected.example.com");
    const client = createClient({
      gatewayUrl: "https://gateway.example.com",
      controlPlaneUrl: "https://control-plane.example.com",
      gatewayClient: injected
    });
    expect(client).toBe(injected);
  });
});

describe("initAssembly env-var fallbacks", () => {
  const originalSeams = { ...__testing._seams };
  const originalGatewayEnv = process.env[ENV_GATEWAY_URL];
  const originalControlPlaneEnv = process.env[ENV_CONTROL_PLANE_URL];

  beforeEach(() => {
    delete process.env[ENV_GATEWAY_URL];
    delete process.env[ENV_CONTROL_PLANE_URL];
    // Keep the resolver from probing / auto-starting a local gateway.
    __testing._seams.loadConfigFile = async () => ({});
    __testing._seams.probeHealthz = async () => true;
    __testing._seams.autoStartGateway = vi.fn();
  });

  afterEach(() => {
    Object.assign(__testing._seams, originalSeams);
    if (originalGatewayEnv === undefined) delete process.env[ENV_GATEWAY_URL];
    else process.env[ENV_GATEWAY_URL] = originalGatewayEnv;
    if (originalControlPlaneEnv === undefined) delete process.env[ENV_CONTROL_PLANE_URL];
    else process.env[ENV_CONTROL_PLANE_URL] = originalControlPlaneEnv;
    vi.restoreAllMocks();
  });

  it("falls back to AA_GATEWAY_URL for the HTTP base URL when no field is set", async () => {
    process.env[ENV_GATEWAY_URL] = "https://env-gateway.example.com";
    const spy = vi.spyOn(gatewayClientModule, "createNoopGatewayClient");

    const ctx = await initAssembly();
    try {
      expect(spy).toHaveBeenCalledWith("auto", "https://env-gateway.example.com");
    } finally {
      await ctx.shutdown();
    }
  });

  it("falls back to AA_CONTROL_PLANE_URL for the HTTP base URL when no field is set", async () => {
    process.env[ENV_GATEWAY_URL] = "https://env-gateway.example.com";
    process.env[ENV_CONTROL_PLANE_URL] = "https://env-control-plane.example.com";
    const spy = vi.spyOn(gatewayClientModule, "createNoopGatewayClient");

    const ctx = await initAssembly();
    try {
      expect(spy).toHaveBeenCalledWith("auto", "https://env-control-plane.example.com");
    } finally {
      await ctx.shutdown();
    }
  });

  it("explicit controlPlaneUrl field overrides AA_CONTROL_PLANE_URL", async () => {
    process.env[ENV_CONTROL_PLANE_URL] = "https://env-control-plane.example.com";
    const spy = vi.spyOn(gatewayClientModule, "createNoopGatewayClient");

    const ctx = await initAssembly({
      gatewayUrl: "https://gateway.example.com",
      controlPlaneUrl: "https://explicit-control-plane.example.com",
      apiKey: "test-key"
    });
    try {
      expect(spy).toHaveBeenCalledWith("auto", "https://explicit-control-plane.example.com");
    } finally {
      await ctx.shutdown();
    }
  });
});
