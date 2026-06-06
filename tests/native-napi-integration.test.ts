import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import blockedAt from "blocked-at";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// Wire tags from aa-sdk-client's codec. The SDK writes inbound tags
// (heartbeat / event-report / policy-query); the runtime replies with an Ack.
const TAG_POLICY_QUERY = 1;
const TAG_EVENT_REPORT = 2;
const TAG_HEARTBEAT = 4;
const TAG_ACK = 3;
const ACK_FRAME = Buffer.from([TAG_ACK, 0x00]);

/**
 * Read a prost varint starting at `start`. Returns the decoded value and the
 * number of bytes consumed, or null if the buffer does not yet hold a complete
 * varint.
 */
function readVarint(
  buf: Buffer,
  start: number
): { value: number; bytes: number } | null {
  let value = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    if (i >= buf.length) return null;
    const byte = buf[i]!;
    i += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, bytes: i - start };
    shift += 7;
    if (shift >= 35) return null;
  }
}

interface MockRuntime {
  server: net.Server;
  /** Count of event-report frames received from the SDK so far. */
  eventCount: () => number;
}

/**
 * Minimal mock of the aa-runtime UDS endpoint. It speaks just enough of the
 * wire codec to keep the shared client's background IPC thread alive — ACKing
 * every heartbeat / event-report / policy-query frame and counting the
 * event-report frames it receives. It performs no scanning or redaction; that
 * is the authoritative runtime's job, not the SDK's.
 */
function startMockRuntime(socketPath: string): Promise<MockRuntime> {
  let events = 0;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let offset = 0;
      for (;;) {
        if (offset >= buf.length) break;
        const tag = buf[offset];
        if (tag === TAG_HEARTBEAT) {
          offset += 1;
          sock.write(ACK_FRAME);
          continue;
        }
        if (tag === TAG_EVENT_REPORT || tag === TAG_POLICY_QUERY) {
          const varint = readVarint(buf, offset + 1);
          if (!varint) break;
          const frameEnd = offset + 1 + varint.bytes + varint.value;
          if (frameEnd > buf.length) break;
          offset = frameEnd;
          if (tag === TAG_EVENT_REPORT) events += 1;
          sock.write(ACK_FRAME);
          continue;
        }
        // Unknown tag — drop a byte so the parser cannot stall.
        offset += 1;
      }
      buf = buf.subarray(offset);
    });
    sock.on("error", () => undefined);
  });
  return new Promise((resolvePromise) => {
    server.listen(socketPath, () =>
      resolvePromise({ server, eventCount: () => events })
    );
  });
}

describeNative("native napi integration", () => {
  let socketDir: string;
  let runtime: MockRuntime | undefined;

  beforeEach(() => {
    socketDir = mkdtempSync(join(tmpdir(), "aa-native-"));
  });

  afterEach(async () => {
    if (runtime) {
      await new Promise<void>((res) => runtime!.server.close(() => res()));
      runtime = undefined;
    }
    rmSync(socketDir, { recursive: true, force: true });
  });

  it("maps native connect failures to NativeConnectError", async () => {
    const client = createNativeClient({
      gateway: "",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action: "probe" })).rejects.toBeInstanceOf(NativeConnectError);
  });

  it("ships events over the real UDS transport without blocking the event loop", async () => {
    const socketPath = join(socketDir, "aa-runtime.sock");
    runtime = await startMockRuntime(socketPath);

    const client = createNativeClient({
      gateway: socketPath,
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    const lagSamples: number[] = [];
    const watcher = blockedAt(
      (timeMs: number) => {
        lagSamples.push(timeMs);
      },
      { threshold: 50, trimFalsePositives: true }
    );

    // Stay within the shared client's bounded IPC channel so the fire-and-forget
    // `sendEvent` does not apply backpressure to the event loop. (The shared
    // client deliberately uses bounded backpressure — unlike the old unbounded
    // node-only stub this shim replaced.)
    const totalEvents = 200;
    await client.queryPolicy({ action: "warmup" });
    const startAt = performance.now();

    for (let i = 0; i < totalEvents; i += 1) {
      client.sendEvent({
        event_type: "tool_call",
        sequence: String(i),
        tool: "search"
      });
    }

    const elapsedMs = performance.now() - startAt;
    watcher.stop();

    // Synchronous enqueue of the whole batch must stay well clear of blocking.
    expect(elapsedMs).toBeLessThan(250);
    const maxLag = lagSamples.length > 0 ? Math.max(...lagSamples) : 0;
    expect(maxLag).toBeLessThan(250);

    // Every event reaches the runtime over the real socket transport.
    await expect
      .poll(() => runtime!.eventCount(), { timeout: 5_000 })
      .toBe(totalEvents);

    await client.close();
  });
});
