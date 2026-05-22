import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GATEWAY_URL,
  loadConfigFile,
  probeHealthz,
  waitForHealthz,
} from "../src/core/gateway-resolver.js";

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
