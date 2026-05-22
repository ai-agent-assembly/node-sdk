import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __testing,
  autoStartGateway,
  DEFAULT_GATEWAY_URL,
  ENV_GATEWAY_URL,
  loadConfigFile,
  probeHealthz,
  resolveGatewayUrl,
  waitForHealthz,
} from "../src/core/gateway-resolver.js";
import { ConfigurationError, GatewayError } from "../src/errors/index.js";

describe("probeHealthz", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns true on 2xx response and probes the /healthz suffix", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(probeHealthz(DEFAULT_GATEWAY_URL)).resolves.toBe(true);

    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe("http://localhost:7391/healthz");
  });

  it("returns false when fetch rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(probeHealthz(DEFAULT_GATEWAY_URL)).resolves.toBe(false);
  });

  it.each([400, 404, 500, 503])("returns false on non-2xx status %i", async (status) => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status } as Response) as unknown as typeof fetch;
    await expect(probeHealthz(DEFAULT_GATEWAY_URL)).resolves.toBe(false);
  });
});

describe("waitForHealthz", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns true on first probe success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(waitForHealthz(DEFAULT_GATEWAY_URL, 5000)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns true after initial failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("refused"))
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce({ status: 200 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(waitForHealthz(DEFAULT_GATEWAY_URL, 5000, 5)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns false when timeout elapses with no success", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("refused")) as unknown as typeof fetch;
    await expect(waitForHealthz(DEFAULT_GATEWAY_URL, 30, 10)).resolves.toBe(false);
  });
});

describe("loadConfigFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "aaasm-1847-cfg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty when the file is missing", async () => {
    await expect(loadConfigFile(join(tmp, "absent.yaml"))).resolves.toEqual({});
  });

  it("returns the parsed mapping for well-formed YAML", async () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(
      cfg,
      'agent:\n  gateway_url: "http://staging.internal:7391"\n  api_key: "k-1"\n',
      "utf8"
    );
    await expect(loadConfigFile(cfg)).resolves.toEqual({
      agent: { gateway_url: "http://staging.internal:7391", api_key: "k-1" }
    });
  });

  it("returns empty when the root is a YAML list (non-mapping)", async () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "- just-a-list\n", "utf8");
    await expect(loadConfigFile(cfg)).resolves.toEqual({});
  });

  it("returns empty when the YAML is malformed", async () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, ":\n  not: valid: yaml: at all\n", "utf8");
    await expect(loadConfigFile(cfg)).resolves.toEqual({});
  });
});

describe("autoStartGateway", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalFind: (typeof __testing._seams)["findAasmOnPath"];
  let originalSpawn: (typeof __testing._seams)["spawnAasm"];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalFind = __testing._seams.findAasmOnPath;
    originalSpawn = __testing._seams.spawnAasm;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __testing._seams.findAasmOnPath = originalFind;
    __testing._seams.spawnAasm = originalSpawn;
    vi.restoreAllMocks();
  });

  it("throws ConfigurationError when aasm is not on PATH", async () => {
    __testing._seams.findAasmOnPath = () => null;
    await expect(autoStartGateway()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(autoStartGateway()).rejects.toThrow(/'aasm' is not on PATH/);
  });

  it("spawns aasm and resolves when healthz becomes ready", async () => {
    const spawnSpy = vi.fn();
    __testing._seams.findAasmOnPath = () => "/usr/local/bin/aasm";
    __testing._seams.spawnAasm = spawnSpy;
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch;

    await expect(autoStartGateway()).resolves.toBeUndefined();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith("/usr/local/bin/aasm");
  });

  it("throws GatewayError when the spawned gateway never becomes ready", async () => {
    __testing._seams.findAasmOnPath = () => "/usr/local/bin/aasm";
    __testing._seams.spawnAasm = vi.fn();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("refused")) as unknown as typeof fetch;

    await expect(autoStartGateway(DEFAULT_GATEWAY_URL, 30)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("resolveGatewayUrl", () => {
  const originalSeams = { ...__testing._seams };
  const originalEnv = process.env[ENV_GATEWAY_URL];

  afterEach(() => {
    Object.assign(__testing._seams, originalSeams);
    if (originalEnv === undefined) delete process.env[ENV_GATEWAY_URL];
    else process.env[ENV_GATEWAY_URL] = originalEnv;
    vi.restoreAllMocks();
  });

  it("short-circuits on the explicit argument", async () => {
    process.env[ENV_GATEWAY_URL] = "http://from-env:7391";
    await expect(resolveGatewayUrl("http://explicit:7391")).resolves.toBe("http://explicit:7391");
  });

  it("uses AAASM_GATEWAY_URL over config + default", async () => {
    process.env[ENV_GATEWAY_URL] = "http://from-env:7391";
    __testing._seams.loadConfigFile = async () => ({
      agent: { gateway_url: "http://from-config:7391" }
    });
    await expect(resolveGatewayUrl()).resolves.toBe("http://from-env:7391");
  });

  it("falls back to config file when env is unset", async () => {
    delete process.env[ENV_GATEWAY_URL];
    __testing._seams.loadConfigFile = async () => ({
      agent: { gateway_url: "http://from-config:7391" }
    });
    await expect(resolveGatewayUrl()).resolves.toBe("http://from-config:7391");
  });

  it("returns the local default when probe succeeds (no auto-start)", async () => {
    delete process.env[ENV_GATEWAY_URL];
    __testing._seams.loadConfigFile = async () => ({});
    __testing._seams.probeHealthz = async () => true;
    const autoStartSpy = vi.fn();
    __testing._seams.autoStartGateway = autoStartSpy;

    await expect(resolveGatewayUrl()).resolves.toBe(DEFAULT_GATEWAY_URL);
    expect(autoStartSpy).not.toHaveBeenCalled();
  });

  it("invokes autoStartGateway when probe fails", async () => {
    delete process.env[ENV_GATEWAY_URL];
    __testing._seams.loadConfigFile = async () => ({});
    __testing._seams.probeHealthz = async () => false;
    const autoStartSpy = vi.fn().mockResolvedValue(undefined);
    __testing._seams.autoStartGateway = autoStartSpy;

    await expect(resolveGatewayUrl()).resolves.toBe(DEFAULT_GATEWAY_URL);
    expect(autoStartSpy).toHaveBeenCalledWith(DEFAULT_GATEWAY_URL);
  });
});
