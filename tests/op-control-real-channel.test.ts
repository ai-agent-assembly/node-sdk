/**
 * Covers the **real-connect path** of `OpControlSubscriber` (`openRealChannel`) —
 * the branch the `clientFactory` test seam deliberately bypasses, and the lines
 * the AAASM-3505 lazy-grpc fix added.
 *
 * Strategy: mock ONLY `./proto/generated/policy.js` so the dynamically-imported
 * `PolicyServiceClient` is a controllable fake (no real gRPC channel / network),
 * but let the real `@grpc/grpc-js` load so the test exercises genuine credential
 * resolution wiring (`resolveOpControlCredentials` → the client constructor),
 * not a mock of it. This asserts behaviour, not just line coverage:
 *   - the channel + client are built lazily after `connect()` returns,
 *   - loopback targets resolve to *insecure* creds and those reach the client,
 *   - the subscription is opened with the agent identity triple,
 *   - signals delivered on the real stream drive `waitForOp`, and
 *   - `close()` racing ahead of the async open prevents client construction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Wire number for `OP_CONTROL_SIGNAL_TERMINATE`. The enum lives in the
 * grpc-importing `policy.js` (mocked here), so we use the stable protobuf
 * number directly — the same constant `op-control.ts` compares against. */
const SIGNAL_TERMINATE = 3;

// Hoisted so the `vi.mock` factory (itself hoisted above imports) can reference
// the fake, while the test body still reaches the recorded calls.
const h = vi.hoisted(() => {
  // Minimal stand-in for a grpc-js `ClientReadableStream` — self-contained (no
  // `node:events` import) so it is safe to define inside this hoisted factory,
  // which runs before module imports are initialized. Exposes the `on(...)` /
  // `cancel()` surface the subscriber uses + a `push()` helper to feed messages.
  class FakeStream {
    private readonly handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    cancelled = false;
    on(event: string, cb: (arg?: unknown) => void): this {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    push(message: unknown): void {
      for (const cb of this.handlers["data"] ?? []) cb(message);
    }
    cancel(): void {
      this.cancelled = true;
    }
  }
  const ctorCalls: Array<{ url: string; creds: unknown }> = [];
  const streamRequests: Array<{ agentId?: unknown }> = [];
  const streams: FakeStream[] = [];
  let closeCount = 0;
  let failConstruct = false;

  class FakePolicyServiceClient {
    constructor(url: string, creds: unknown) {
      if (failConstruct) throw new Error("channel open failed");
      ctorCalls.push({ url, creds });
    }
    opControlStream(request: { agentId?: unknown }): FakeStream {
      streamRequests.push(request);
      const s = new FakeStream();
      streams.push(s);
      return s;
    }
    close(): void {
      closeCount += 1;
    }
  }

  return {
    FakePolicyServiceClient,
    ctorCalls,
    streamRequests,
    streams,
    closeCount: (): number => closeCount,
    setFailConstruct: (v: boolean): void => {
      failConstruct = v;
    },
    reset(): void {
      ctorCalls.length = 0;
      streamRequests.length = 0;
      streams.length = 0;
      closeCount = 0;
      failConstruct = false;
    }
  };
});

vi.mock("../src/proto/generated/policy.js", () => ({
  PolicyServiceClient: h.FakePolicyServiceClient
}));

import { OpControlSubscriber } from "../src/op-control.js";
import { OpTerminatedError } from "../src/errors/op-terminated-error.js";

/** grpc-js `ChannelCredentials` exposes `_isSecure()` — false for insecure. */
const isSecure = (creds: unknown): boolean =>
  (creds as { _isSecure(): boolean })._isSecure();

const OPTS = { orgId: "acme", teamId: "alpha", agentId: "agent-1" };

describe("OpControlSubscriber real-connect path (openRealChannel)", () => {
  beforeEach(() => h.reset());

  it("lazily builds the client with resolved (loopback → insecure) creds, subscribes with the agent triple, and dispatches signals", async () => {
    const sub = OpControlSubscriber.connect("localhost:7391", OPTS);

    // The client is built asynchronously (after the lazy grpc + policy imports),
    // so connect() returns before it exists.
    expect(h.ctorCalls).toHaveLength(0);
    await vi.waitFor(() => expect(h.ctorCalls).toHaveLength(1));

    // Wiring: the gateway URL and the *resolved* credentials reach the client.
    expect(h.ctorCalls[0]!.url).toBe("localhost:7391");
    expect(isSecure(h.ctorCalls[0]!.creds)).toBe(false); // loopback → insecure

    // The subscription carries the agent identity triple.
    expect(h.streamRequests[0]).toEqual({ agentId: OPTS });
    expect(sub.streamAlive()).toBe(true);

    // End-to-end: a TERMINATE on the real stream makes waitForOp reject.
    h.streams[0]!.push({ opId: "op-x", signal: SIGNAL_TERMINATE, sequence: 0 });
    await expect(sub.waitForOp("op-x")).rejects.toBeInstanceOf(OpTerminatedError);

    // close() propagates to the underlying client + cancels the stream.
    sub.close();
    expect(h.closeCount()).toBe(1);
    expect(h.streams[0]!.cancelled).toBe(true);
    expect(sub.streamAlive()).toBe(false);
  });

  it("resolves a non-loopback target to secure (TLS) creds", async () => {
    OpControlSubscriber.connect("gateway.prod.example:443", OPTS);
    await vi.waitFor(() => expect(h.ctorCalls).toHaveLength(1));
    expect(isSecure(h.ctorCalls[0]!.creds)).toBe(true);
  });

  it("close() before the async channel open wins — no client is built and the stream is marked dead", async () => {
    const sub = OpControlSubscriber.connect("localhost:7391", OPTS);
    // Synchronous close, before the awaited dynamic imports in openRealChannel resolve.
    sub.close();

    // Let openRealChannel resume past its awaits and hit the `closed` guard.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.ctorCalls).toHaveLength(0); // guard returned before constructing the client
    expect(h.streamRequests).toHaveLength(0); // and before opening the stream
    expect(sub.streamAlive()).toBe(false); // close() marked the stream dead
  });

  it("a failure opening the real channel surfaces as a dead stream (fail-safe), not an unhandled rejection", async () => {
    h.setFailConstruct(true);
    const sub = OpControlSubscriber.connect("localhost:7391", OPTS);

    // openRealChannel rejects → connect()'s `.catch` marks the stream dead so
    // callers observe streamAlive() === false (per the module's documented contract).
    await vi.waitFor(() => expect(sub.streamAlive()).toBe(false));
    expect(h.ctorCalls).toHaveLength(0); // construction threw before recording
  });
});
