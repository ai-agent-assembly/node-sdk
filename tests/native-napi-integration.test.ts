import { existsSync } from "node:fs";
import { resolve } from "node:path";
import blockedAt from "blocked-at";
import { describe, expect, it } from "vitest";
import { NativeConnectError, createNativeClient } from "../src/native/client.js";

const NATIVE_ADDON_DIR = resolve(process.cwd(), "native/aa-ffi-node");
const RUN_NATIVE_TESTS =
  process.env.AA_NATIVE_TEST === "1" &&
  (existsSync(resolve(NATIVE_ADDON_DIR, "index.node")) ||
    existsSync(resolve(NATIVE_ADDON_DIR, "index.darwin-arm64.node")) ||
    existsSync(resolve(NATIVE_ADDON_DIR, "index.darwin-x64.node")) ||
    existsSync(resolve(NATIVE_ADDON_DIR, "index.linux-x64-gnu.node")) ||
    existsSync(resolve(NATIVE_ADDON_DIR, "index.win32-x64-msvc.node")));

const describeNative = RUN_NATIVE_TESTS ? describe : describe.skip;

describeNative("native napi integration", () => {
  it("maps native connect failures to NativeConnectError", async () => {
    const client = createNativeClient({
      gateway: "",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action: "probe" })).rejects.toBeInstanceOf(NativeConnectError);
  });

  it("handles 10k sendEvent calls without meaningful event-loop lag", async () => {
    const client = createNativeClient({
      gateway: "/tmp/aa-runtime.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    const lagSamples: number[] = [];
    const watcher = blockedAt(
      (timeMs: number) => {
        lagSamples.push(timeMs);
      },
      {
        threshold: 50,
        trimFalsePositives: true
      }
    );

    const totalEvents = 10_000;
    await client.queryPolicy({ action: "warmup" });
    const startAt = performance.now();

    for (let i = 0; i < totalEvents; i += 1) {
      client.sendEvent({
        sequence: i,
        action: "tool_call",
        payload: { tool: "search", args: { q: `query-${i}` } }
      });
    }

    // Ensure the async queue has progressed before we evaluate throughput.
    await client.queryPolicy({ action: "flush" });
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));

    const elapsedMs = performance.now() - startAt;
    const throughput = totalEvents / (elapsedMs / 1000);

    watcher.stop();

    expect(throughput).toBeGreaterThanOrEqual(10_000);
    const maxLag = lagSamples.length > 0 ? Math.max(...lagSamples) : 0;
    // Absolute latency bounds are runner-dependent and flake on shared CI
    // runners (especially Windows). Keep a tight bound locally, but allow
    // generous headroom in CI — a genuine regression still trips the 1s
    // ceiling, while ~4% timing jitter no longer fails the build. (AAASM-2548)
    const maxLagBudgetMs = process.env.CI ? 1000 : 250;
    expect(maxLag).toBeLessThan(maxLagBudgetMs);

    await client.close();
  });
});
