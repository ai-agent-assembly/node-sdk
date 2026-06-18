import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __testing,
  assertAllowedAasmPath,
  autoStartGateway,
  DEFAULT_GATEWAY_URL,
  ENV_API_KEY,
  ENV_AUTO_START,
  ENV_GATEWAY_URL,
  LEGACY_ENV_API_KEY,
  LEGACY_ENV_GATEWAY_URL,
  loadConfigFile,
  probeHealthz,
  resolveApiKey,
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

  it("strips trailing slashes from the base URL before appending /healthz", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(probeHealthz("http://localhost:7391///")).resolves.toBe(true);

    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe("http://localhost:7391/healthz");
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
  const originalLegacyEnv = process.env[LEGACY_ENV_GATEWAY_URL];
  const originalAutoStartEnv = process.env[ENV_AUTO_START];

  beforeEach(() => {
    delete process.env[ENV_GATEWAY_URL];
    delete process.env[LEGACY_ENV_GATEWAY_URL];
    delete process.env[ENV_AUTO_START];
    __testing.resetLegacyEnvWarnings();
  });

  afterEach(() => {
    Object.assign(__testing._seams, originalSeams);
    if (originalEnv === undefined) delete process.env[ENV_GATEWAY_URL];
    else process.env[ENV_GATEWAY_URL] = originalEnv;
    if (originalLegacyEnv === undefined) delete process.env[LEGACY_ENV_GATEWAY_URL];
    else process.env[LEGACY_ENV_GATEWAY_URL] = originalLegacyEnv;
    if (originalAutoStartEnv === undefined) delete process.env[ENV_AUTO_START];
    else process.env[ENV_AUTO_START] = originalAutoStartEnv;
    __testing.resetLegacyEnvWarnings();
    vi.restoreAllMocks();
  });

  it("short-circuits on the explicit argument", async () => {
    process.env[ENV_GATEWAY_URL] = "http://from-env:7391";
    await expect(resolveGatewayUrl("http://explicit:7391")).resolves.toBe("http://explicit:7391");
  });

  it("uses AA_GATEWAY_URL over config + default", async () => {
    process.env[ENV_GATEWAY_URL] = "http://from-env:7391";
    __testing._seams.loadConfigFile = async () => ({
      agent: { gateway_url: "http://from-config:7391" }
    });
    await expect(resolveGatewayUrl()).resolves.toBe("http://from-env:7391");
  });

  it("falls back to the deprecated AAASM_GATEWAY_URL and warns once", async () => {
    process.env[LEGACY_ENV_GATEWAY_URL] = "http://from-legacy:7391";
    __testing._seams.loadConfigFile = async () => ({
      agent: { gateway_url: "http://from-config:7391" }
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(resolveGatewayUrl()).resolves.toBe("http://from-legacy:7391");
    await expect(resolveGatewayUrl()).resolves.toBe("http://from-legacy:7391");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain(LEGACY_ENV_GATEWAY_URL);
    expect(warnSpy.mock.calls[0]![0]).toContain(ENV_GATEWAY_URL);
  });

  it("prefers AA_GATEWAY_URL over the legacy alias and does not warn", async () => {
    process.env[ENV_GATEWAY_URL] = "http://from-canonical:7391";
    process.env[LEGACY_ENV_GATEWAY_URL] = "http://from-legacy:7391";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(resolveGatewayUrl()).resolves.toBe("http://from-canonical:7391");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to config file when neither env name is set", async () => {
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

  it("invokes autoStartGateway when probe fails and AA_AUTO_START is opted in", async () => {
    process.env[ENV_AUTO_START] = "1";
    delete process.env[ENV_GATEWAY_URL];
    __testing._seams.loadConfigFile = async () => ({});
    __testing._seams.probeHealthz = async () => false;
    const autoStartSpy = vi.fn().mockResolvedValue(undefined);
    __testing._seams.autoStartGateway = autoStartSpy;

    await expect(resolveGatewayUrl()).resolves.toBe(DEFAULT_GATEWAY_URL);
    expect(autoStartSpy).toHaveBeenCalledWith(DEFAULT_GATEWAY_URL);
  });

  it("throws ConfigurationError instead of auto-starting when AA_AUTO_START is unset", async () => {
    delete process.env[ENV_GATEWAY_URL];
    delete process.env[ENV_AUTO_START];
    __testing._seams.loadConfigFile = async () => ({});
    __testing._seams.probeHealthz = async () => false;
    const autoStartSpy = vi.fn().mockResolvedValue(undefined);
    __testing._seams.autoStartGateway = autoStartSpy;

    await expect(resolveGatewayUrl()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(resolveGatewayUrl()).rejects.toThrow(new RegExp(ENV_AUTO_START));
    expect(autoStartSpy).not.toHaveBeenCalled();
  });
});

describe("assertAllowedAasmPath", () => {
  it("accepts an absolute path inside an allow-listed install dir", () => {
    expect(() => assertAllowedAasmPath("/usr/local/bin/aasm")).not.toThrow();
  });

  it("rejects a relative / PATH-injected path", () => {
    expect(() => assertAllowedAasmPath("aasm")).toThrow(ConfigurationError);
    expect(() => assertAllowedAasmPath("./aasm")).toThrow(/non-absolute/);
  });

  it("rejects an absolute path outside the install allow-list", () => {
    expect(() => assertAllowedAasmPath("/tmp/evil/aasm")).toThrow(ConfigurationError);
    expect(() => assertAllowedAasmPath("/tmp/evil/aasm")).toThrow(/untrusted location/);
  });
});

describe("resolveApiKey", () => {
  const originalSeams = { ...__testing._seams };
  const originalEnv = process.env[ENV_API_KEY];
  const originalLegacyEnv = process.env[LEGACY_ENV_API_KEY];

  beforeEach(() => {
    delete process.env[ENV_API_KEY];
    delete process.env[LEGACY_ENV_API_KEY];
    __testing.resetLegacyEnvWarnings();
  });

  afterEach(() => {
    Object.assign(__testing._seams, originalSeams);
    if (originalEnv === undefined) delete process.env[ENV_API_KEY];
    else process.env[ENV_API_KEY] = originalEnv;
    if (originalLegacyEnv === undefined) delete process.env[LEGACY_ENV_API_KEY];
    else process.env[LEGACY_ENV_API_KEY] = originalLegacyEnv;
    __testing.resetLegacyEnvWarnings();
    vi.restoreAllMocks();
  });

  it("short-circuits on the explicit argument", async () => {
    process.env[ENV_API_KEY] = "k-env";
    await expect(resolveApiKey("k-explicit")).resolves.toBe("k-explicit");
  });

  it("uses AA_API_KEY over config-file value", async () => {
    process.env[ENV_API_KEY] = "k-env";
    __testing._seams.loadConfigFile = async () => ({
      agent: { api_key: "k-config" }
    });
    await expect(resolveApiKey()).resolves.toBe("k-env");
  });

  it("falls back to the deprecated AAASM_API_KEY and warns once", async () => {
    process.env[LEGACY_ENV_API_KEY] = "k-legacy";
    __testing._seams.loadConfigFile = async () => ({
      agent: { api_key: "k-config" }
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(resolveApiKey()).resolves.toBe("k-legacy");
    await expect(resolveApiKey()).resolves.toBe("k-legacy");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain(LEGACY_ENV_API_KEY);
    expect(warnSpy.mock.calls[0]![0]).toContain(ENV_API_KEY);
  });

  it("prefers AA_API_KEY over the legacy alias and does not warn", async () => {
    process.env[ENV_API_KEY] = "k-canonical";
    process.env[LEGACY_ENV_API_KEY] = "k-legacy";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(resolveApiKey()).resolves.toBe("k-canonical");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to config file when neither env name is set", async () => {
    __testing._seams.loadConfigFile = async () => ({
      agent: { api_key: "k-config" }
    });
    await expect(resolveApiKey()).resolves.toBe("k-config");
  });

  it("returns empty string as the documented local-mode default", async () => {
    __testing._seams.loadConfigFile = async () => ({});
    await expect(resolveApiKey()).resolves.toBe("");
  });
});

describe("default PATH lookup and spawn seams", () => {
  // Capture the production default implementations before any other suite can
  // reassign the mutable _seams entries.
  const defaultFindAasmOnPath = __testing._seams.findAasmOnPath;
  const defaultSpawnAasm = __testing._seams.spawnAasm;

  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  it("findAasmOnPath returns the first matching binary across PATH entries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aaasm-3177-find-"));
    try {
      writeFileSync(join(tmp, "aasm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // Prepend a guaranteed-miss dir to exercise the skip-and-continue branch.
      process.env.PATH = [join(tmp, "no-such-dir"), tmp].join(":");
      expect(defaultFindAasmOnPath()).toBe(join(tmp, "aasm"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("findAasmOnPath returns null when no PATH entry holds the binary", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aaasm-3177-nofind-"));
    try {
      process.env.PATH = tmp;
      expect(defaultFindAasmOnPath()).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("spawnAasm detaches a background subprocess from the resolved binary", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aaasm-3177-spawn-"));
    try {
      const bin = join(tmp, "aasm");
      // A trivially-exiting script: spawn must launch and unref it without
      // throwing or keeping the event loop alive.
      writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(() => defaultSpawnAasm(bin)).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
