/**
 * AAASM-3105 — fail-closed when `enforce` is requested without a check-capable
 * client.
 *
 * The no-op gateway client's `check()` is allow-all, so routing an agent
 * registered under live `"enforce"` through it would silently let a
 * policy-denied action proceed (a fail-open). `createClient` must instead
 * refuse loudly. `"observe"` / `"disabled"` (and an omitted mode) intentionally
 * let actions through and must keep returning the allow-all no-op client.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "../src/core/init-assembly.js";
import { ConfigurationError } from "../src/errors/index.js";
import type { EnforcementMode } from "../src/index.js";
import type { AssemblyMode } from "../src/types/assembly-mode.js";

const NON_CHECK_CAPABLE_MODES: readonly AssemblyMode[] = ["auto", "grpc-sidecar", "sdk-only"];

describe("createClient fail-closed under enforce (AAASM-3105)", () => {
  it.each(NON_CHECK_CAPABLE_MODES)(
    "throws ConfigurationError for enforce + %s (no check-capable client)",
    (mode) => {
      expect(() =>
        createClient({
          gatewayUrl: "https://gateway.example.com",
          apiKey: "k",
          agentId: "agent-1",
          mode,
          enforcementMode: "enforce"
        })
      ).toThrow(ConfigurationError);
    }
  );

  it("throws for enforce when mode is omitted (defaults to the allow-all auto path)", () => {
    expect(() =>
      createClient({
        gatewayUrl: "https://gateway.example.com",
        apiKey: "k",
        enforcementMode: "enforce"
      })
    ).toThrow(ConfigurationError);
  });

  it.each(["observe", "disabled"] as const)(
    "does not throw for %s in auto mode and keeps the allow-all no-op client",
    async (enforcementMode: EnforcementMode) => {
      const client = createClient({
        gatewayUrl: "https://gateway.example.com",
        apiKey: "k",
        enforcementMode
      });
      await expect(
        client.check({ action: "tool_call", toolName: "rm", runId: "run-1" })
      ).resolves.toEqual({ denied: false, pending: false });
    }
  );

  it("does not throw when enforcementMode is omitted (pre-feature behavior)", () => {
    expect(() =>
      createClient({ gatewayUrl: "https://gateway.example.com", apiKey: "k" })
    ).not.toThrow();
  });

  it("honors a caller-supplied gatewayClient under enforce (no fail-closed)", () => {
    const ownClient = createClient({
      gatewayUrl: "https://gateway.example.com",
      apiKey: "k",
      enforcementMode: "observe"
    });
    expect(() =>
      createClient({
        gatewayUrl: "https://gateway.example.com",
        apiKey: "k",
        enforcementMode: "enforce",
        gatewayClient: ownClient
      })
    ).not.toThrow();
  });
});
