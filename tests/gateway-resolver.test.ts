import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GATEWAY_URL,
  probeHealthz,
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
