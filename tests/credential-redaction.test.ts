import { describe, expect, it, vi } from "vitest";

import { redactErrorMessage, redactSecrets, REDACTED } from "../src/core/redact.js";
import { CheckActionRequest } from "../src/proto/generated/policy.js";

/**
 * Credential/token hygiene for the Node SDK (AAASM-3645).
 *
 * The resolved `apiKey` and the proto `credentialToken` must never reach
 * `console.*` or an accidental `JSON.stringify` dump. These tests pin:
 *   1. `redactSecrets` strips both fields from a CheckActionRequest-shaped
 *      object and a config object (the wire `toJSON` is NOT for logging).
 *   2. `redactErrorMessage` scrubs a `Bearer <token>` substring.
 *   3. End-to-end: the `initAssembly` registration-failure `console.warn` never
 *      emits a sentinel apiKey/credentialToken, even when the register error
 *      embeds the bearer header.
 */

const SENTINEL_KEY = "SENTINEL-API-KEY-DO-NOT-LOG";
const SENTINEL_TOKEN = "SENTINEL-CRED-TOKEN-DO-NOT-LOG";

describe("redactSecrets (AAASM-3645)", () => {
  it("strips credentialToken from a CheckActionRequest diagnostic dump", () => {
    const request = CheckActionRequest.fromPartial({
      credentialToken: SENTINEL_TOKEN,
      traceId: "trace-1",
      actionType: 0
    });

    // toJSON is wire-only and DOES contain the token — proving the leak path.
    const wire = JSON.stringify(CheckActionRequest.toJSON(request));
    expect(wire).toContain(SENTINEL_TOKEN);

    // The redacted form is what may be logged — token gone, shape kept.
    const safe = JSON.stringify(redactSecrets(CheckActionRequest.toJSON(request)));
    expect(safe).not.toContain(SENTINEL_TOKEN);
    expect(safe).toContain(REDACTED);
    expect(safe).toContain("trace-1");
  });

  it("strips apiKey from a config object (case-insensitive, nested)", () => {
    const config = {
      gatewayUrl: "http://gw.test",
      apiKey: SENTINEL_KEY,
      nested: { credential_token: SENTINEL_TOKEN, agentId: "a" }
    };
    const safe = JSON.stringify(redactSecrets(config));
    expect(safe).not.toContain(SENTINEL_KEY);
    expect(safe).not.toContain(SENTINEL_TOKEN);
    expect(safe).toContain("http://gw.test");
    expect(safe).toContain("a");
  });

  it("strips the widened secret-key set: password/secret/x-api-key/cookie/set-cookie (AAASM-3896)", () => {
    const config = {
      keepMe: "visible",
      password: "SENTINEL-PASSWORD",
      Secret: "SENTINEL-SECRET",
      "X-API-Key": "SENTINEL-XAPIKEY",
      Cookie: "SENTINEL-COOKIE",
      "set-cookie": "SENTINEL-SETCOOKIE"
    };
    const safe = JSON.stringify(redactSecrets(config));
    for (const sentinel of [
      "SENTINEL-PASSWORD",
      "SENTINEL-SECRET",
      "SENTINEL-XAPIKEY",
      "SENTINEL-COOKIE",
      "SENTINEL-SETCOOKIE"
    ]) {
      expect(safe).not.toContain(sentinel);
    }
    expect(safe).toContain(REDACTED);
    expect(safe).toContain("visible");
  });

  it("strips the AAASM-3925 key set and suffix/substring variants", () => {
    const config = {
      access_token: "SENTINEL-ACCESS",
      refresh_token: "SENTINEL-REFRESH",
      client_secret: "SENTINEL-CLIENTSECRET",
      private_key: "SENTINEL-PRIVKEY",
      credential: "SENTINEL-CRED",
      passwd: "SENTINEL-PASSWD",
      session: "SENTINEL-SESSION",
      "api-key": "SENTINEL-APIKEY",
      // Suffix / substring matches for future variants.
      sessionToken: "SENTINEL-SESSIONTOKEN",
      dbPassword: "SENTINEL-DBPASSWORD",
      vaultSecret: "SENTINEL-VAULTSECRET"
    };
    const safe = JSON.stringify(redactSecrets(config));
    for (const sentinel of [
      "SENTINEL-ACCESS",
      "SENTINEL-REFRESH",
      "SENTINEL-CLIENTSECRET",
      "SENTINEL-PRIVKEY",
      "SENTINEL-CRED",
      "SENTINEL-PASSWD",
      "SENTINEL-SESSION",
      "SENTINEL-APIKEY",
      "SENTINEL-SESSIONTOKEN",
      "SENTINEL-DBPASSWORD",
      "SENTINEL-VAULTSECRET"
    ]) {
      expect(safe).not.toContain(sentinel);
    }
  });

  it("does NOT over-redact benign keys that only start with a secret word", () => {
    const config = {
      secretSantaName: "Alice",
      tokenCount: 42,
      keyValueStore: "kv"
    };
    const safe = redactSecrets(config) as Record<string, unknown>;
    expect(safe.secretSantaName).toBe("Alice");
    expect(safe.tokenCount).toBe(42);
    expect(safe.keyValueStore).toBe("kv");
  });
});

describe("redactErrorMessage (AAASM-3645, AAASM-3925)", () => {
  it("scrubs a Bearer credential from an error string", () => {
    const err = new Error(`401 from gateway (Authorization: Bearer ${SENTINEL_KEY})`);
    const scrubbed = redactErrorMessage(err);
    expect(scrubbed).not.toContain(SENTINEL_KEY);
    expect(scrubbed).toContain(REDACTED);
  });

  it("scrubs a bare JWT carried without a Bearer prefix", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRU5USU5FTC1KV1QtU1VCIn0.c2lnbmF0dXJlLXNlbnRpbmVs";
    const scrubbed = redactErrorMessage(new Error(`token rejected: ${jwt}`));
    expect(scrubbed).not.toContain("SENTINEL-JWT");
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).toContain(REDACTED);
  });

  it("scrubs a bare sk- API key", () => {
    const scrubbed = redactErrorMessage(new Error("openai error: sk-SENTINELabc123XYZ456"));
    expect(scrubbed).not.toContain("sk-SENTINELabc123XYZ456");
    expect(scrubbed).toContain(REDACTED);
  });

  it("scrubs a credential-bearing URL query parameter", () => {
    const scrubbed = redactErrorMessage(
      new Error("GET https://gw.test/cb?access_token=SENTINEL-QTOKEN&page=2 failed")
    );
    expect(scrubbed).not.toContain("SENTINEL-QTOKEN");
    expect(scrubbed).toContain(REDACTED);
    // Non-credential query params are preserved.
    expect(scrubbed).toContain("page=2");
  });

  it("scrubs URL userinfo credentials (AAASM-4951)", () => {
    const scrubbed = redactErrorMessage(
      new Error("connect failed: https://svcuser:SENTINEL-PASS@gw.test:8443/path?page=2")
    );
    expect(scrubbed).not.toContain("SENTINEL-PASS");
    expect(scrubbed).not.toContain("svcuser");
    expect(scrubbed).toContain(REDACTED);
    // Host, port, path, and non-credential query survive.
    expect(scrubbed).toContain("gw.test:8443/path");
    expect(scrubbed).toContain("page=2");
  });

  it("leaves a credential-free URL untouched (AAASM-4951)", () => {
    const scrubbed = redactErrorMessage(new Error("GET https://gw.test:8443/path failed"));
    expect(scrubbed).toBe("Error: GET https://gw.test:8443/path failed");
  });
});

interface MockBinding {
  connect: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  queryPolicy: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

async function loadWithBinding(binding: MockBinding) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => () => binding
  }));
  return import("../src/index.js");
}

describe("initAssembly registration-failure log is credential-free (AAASM-3645)", () => {
  it("never logs the apiKey/bearer when registration throws an auth error", async () => {
    const binding: MockBinding = {
      connect: vi.fn(async () => ({ id: "handle" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(async () => ({ decision: "allow", reason: "" })),
      // Worst case: the register error itself carries the bearer header.
      register: vi.fn(async () => {
        throw new Error(`AA_ERR_REGISTER: rejected (Authorization: Bearer ${SENTINEL_KEY})`);
      }),
      disconnect: vi.fn(async () => undefined)
    };
    const { initAssembly } = await loadWithBinding(binding);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const ctx = await initAssembly({
      gatewayUrl: "/tmp/aa.sock",
      apiKey: SENTINEL_KEY,
      agentId: "agent-x",
      mode: "napi-inprocess"
    });
    await ctx.shutdown();

    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("proceeding unregistered");
    expect(logged).not.toContain(SENTINEL_KEY);
    warn.mockRestore();
  });
});
