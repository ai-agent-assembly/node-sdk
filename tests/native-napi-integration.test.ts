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

// Wire tags from aa-sdk-client's codec. The SDK writes outbound tags
// (heartbeat / event-report / policy-query); the runtime replies with an Ack to
// heartbeats and event-reports, and with a PolicyResponse to a policy-query.
const TAG_POLICY_QUERY = 1;
const TAG_EVENT_REPORT = 2;
const TAG_HEARTBEAT = 4;
const TAG_ACK = 3;
// SDK → runtime signed handshake proof (AAASM-3587). The runtime issues the
// challenge first; the SDK replies with this frame before any other traffic.
const TAG_HANDSHAKE_PROOF = 5;
// Inbound (runtime → SDK) policy-response tag.
const TAG_POLICY_RESPONSE = 1;
// Runtime → SDK handshake challenge (AAASM-3587), the first frame the runtime
// sends on connect.
const TAG_HANDSHAKE_CHALLENGE = 5;
const ACK_FRAME = Buffer.from([TAG_ACK, 0x00]);

// A `HandshakeChallenge { nonce: bytes }` (proto field 1, wire type 2) carrying
// a fixed 32-byte nonce, framed as [tag, length-delimiter varint, body]. The
// real runtime issues a random nonce; the mock only needs a decodable challenge
// so the client completes the AAASM-3587 handshake and starts shipping events.
// The mock does not verify the resulting proof — that is the authoritative
// runtime's job; here the handshake just has to advance so the event flow opens.
const HANDSHAKE_NONCE = Buffer.alloc(32, 0x5a);
const HANDSHAKE_CHALLENGE_BODY = Buffer.concat([
  Buffer.from([0x0a, HANDSHAKE_NONCE.length]),
  HANDSHAKE_NONCE
]);
const HANDSHAKE_CHALLENGE_FRAME = Buffer.concat([
  Buffer.from([TAG_HANDSHAKE_CHALLENGE, HANDSHAKE_CHALLENGE_BODY.length]),
  HANDSHAKE_CHALLENGE_BODY
]);
// A `CheckActionResponse { decision: ALLOW }` — proto field 1 (varint) = 1.
// Framed as [tag, length-delimiter varint, body]; the 2-byte body fits in a
// single-byte length varint. The runtime answers a policy-query with this,
// NOT an Ack — an Ack would leave the SDK's query blocked until its 5s timeout.
const POLICY_RESPONSE_ALLOW_FRAME = Buffer.from([
  TAG_POLICY_RESPONSE,
  0x02,
  0x08,
  0x01
]);

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
 * wire codec to keep the shared client's background IPC thread alive — issuing
 * the AAASM-3587 handshake challenge on connect and consuming the SDK's signed
 * proof, ACKing every heartbeat / event-report frame, answering a policy-query
 * with an allow `PolicyResponse` (as the real runtime does — an Ack would leave
 * the query blocked until its 5s timeout), and counting the event-report frames
 * it receives. It performs no scanning, redaction, or proof verification; that
 * is the authoritative runtime's job, not the SDK's.
 */
function startMockRuntime(socketPath: string): Promise<MockRuntime> {
  let events = 0;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    // AAASM-3587: the runtime sends the handshake challenge first; the client's
    // IPC thread completes the handshake (fail-closed) before any other traffic.
    sock.write(HANDSHAKE_CHALLENGE_FRAME);
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
        if (tag === TAG_HANDSHAKE_PROOF) {
          // Length-delimited proof frame; consume and discard it (the mock does
          // not verify the proof). Wait for the whole frame before advancing.
          const varint = readVarint(buf, offset + 1);
          if (!varint) break;
          const frameEnd = offset + 1 + varint.bytes + varint.value;
          if (frameEnd > buf.length) break;
          offset = frameEnd;
          continue;
        }
        if (tag === TAG_EVENT_REPORT || tag === TAG_POLICY_QUERY) {
          const varint = readVarint(buf, offset + 1);
          if (!varint) break;
          const frameEnd = offset + 1 + varint.bytes + varint.value;
          if (frameEnd > buf.length) break;
          offset = frameEnd;
          if (tag === TAG_EVENT_REPORT) {
            events += 1;
            sock.write(ACK_FRAME);
          } else {
            // A policy-query is answered with a PolicyResponse, not an Ack.
            sock.write(POLICY_RESPONSE_ALLOW_FRAME);
          }
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
