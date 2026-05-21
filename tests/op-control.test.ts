/**
 * Unit tests for the OpControlSubscriber (AAASM-1422 PR-F / AAASM-1655).
 *
 * The subscriber owns a gRPC stream reader that dispatches signals to a
 * per-op state machine. We exercise it by injecting a hand-rolled stub
 * whose `opControlStream` returns a controllable EventEmitter — no gRPC
 * server stood up. Mirrors the python-sdk PR-E test seam pattern.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { OpTerminatedError } from "../src/errors/op-terminated-error.js";
import { OpControlSubscriber, type OpControlClient } from "../src/op-control.js";
import { type OpControlMessage, OpControlSignal } from "../src/proto/generated/policy.js";

/**
 * Stands in for a grpc-js `ClientReadableStream<OpControlMessage>` — exposes
 * the `on(...)`/`cancel()` surface the subscriber uses + a `push()` helper
 * for the test to fan messages through.
 */
class FakeStream extends EventEmitter {
  public cancelled = false;

  push(message: OpControlMessage): void {
    this.emit("data", message);
  }

  end(): void {
    this.emit("end");
  }

  errorOut(err: Error): void {
    this.emit("error", err);
  }

  cancel(): void {
    this.cancelled = true;
    this.end();
  }
}

function makeClient(stream: FakeStream): OpControlClient & { lastRequest?: { agentId?: unknown } } {
  const wrapper: { stream: FakeStream; lastRequest?: { agentId?: unknown } } = {
    stream,
  };
  return {
    stream: wrapper.stream as unknown as never, // unused field for inspection
    get lastRequest() {
      return wrapper.lastRequest;
    },
    opControlStream(request: { agentId?: unknown }): never {
      wrapper.lastRequest = request;
      // Cast: vitest doesn't care that FakeStream isn't the exact grpc-js type.
      return stream as never;
    },
  } as unknown as OpControlClient & { lastRequest?: { agentId?: unknown } };
}

function message(opId: string, signal: OpControlSignal, sequence = 0): OpControlMessage {
  return { opId, signal, sequence };
}

function buildSubscriber(stream: FakeStream): { sub: OpControlSubscriber; client: ReturnType<typeof makeClient> } {
  const client = makeClient(stream);
  const sub = OpControlSubscriber.connect("ignored", {
    orgId: "org",
    teamId: "team",
    agentId: "agent-7",
    clientFactory: () => client,
  });
  return { sub, client };
}

describe("OpControlSubscriber", () => {
  it("returns immediately when waiting on an op with no signals yet", async () => {
    const stream = new FakeStream();
    const { sub } = buildSubscriber(stream);
    await sub.waitForOp("never-seen", { timeoutMs: 50 });
    sub.close();
  });

  it("blocks waitForOp while paused; unblocks on resume", async () => {
    const stream = new FakeStream();
    const { sub } = buildSubscriber(stream);

    stream.push(message("op-1", OpControlSignal.OP_CONTROL_SIGNAL_PAUSE));
    expect(sub.isPaused("op-1")).toBe(true);

    let resolved = false;
    const waiter = sub.waitForOp("op-1", { timeoutMs: 2000 }).then(() => {
      resolved = true;
    });
    // Give the event loop a tick — the waiter must still be pending.
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    stream.push(message("op-1", OpControlSignal.OP_CONTROL_SIGNAL_RESUME, 1));
    await waiter;
    expect(resolved).toBe(true);
    expect(sub.isPaused("op-1")).toBe(false);

    sub.close();
  });

  it("rejects with OpTerminatedError when the gateway terminates the op", async () => {
    const stream = new FakeStream();
    const { sub } = buildSubscriber(stream);

    stream.push(message("op-2", OpControlSignal.OP_CONTROL_SIGNAL_TERMINATE));
    expect(sub.isTerminated("op-2")).toBe(true);

    await expect(sub.waitForOp("op-2")).rejects.toMatchObject({
      name: "OpTerminatedError",
      opId: "op-2",
    });

    sub.close();
  });

  it("terminating an op while a waiter is blocked rejects that waiter", async () => {
    const stream = new FakeStream();
    const { sub } = buildSubscriber(stream);

    stream.push(message("op-3", OpControlSignal.OP_CONTROL_SIGNAL_PAUSE));

    const waiter = sub.waitForOp("op-3", { timeoutMs: 2000 });

    stream.push(message("op-3", OpControlSignal.OP_CONTROL_SIGNAL_TERMINATE, 1));
    await expect(waiter).rejects.toBeInstanceOf(OpTerminatedError);

    sub.close();
  });

  it("buffers a pause signal that arrives before any waiter is registered", async () => {
    const stream = new FakeStream();
    const { sub } = buildSubscriber(stream);

    stream.push(message("op-4", OpControlSignal.OP_CONTROL_SIGNAL_PAUSE));
    // No one is awaiting yet; the slot must still remember the pause.
    expect(sub.isPaused("op-4")).toBe(true);

    let resolved = false;
    const waiter = sub.waitForOp("op-4", { timeoutMs: 2000 }).then(() => {
      resolved = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    stream.push(message("op-4", OpControlSignal.OP_CONTROL_SIGNAL_RESUME, 1));
    await waiter;
    expect(resolved).toBe(true);

    sub.close();
  });

  it("subscribe request carries the composite agent id triple", () => {
    const stream = new FakeStream();
    const { client } = buildSubscriber(stream);
    expect(client.lastRequest).toBeDefined();
    expect(client.lastRequest?.agentId).toEqual({
      orgId: "org",
      teamId: "team",
      agentId: "agent-7",
    });
  });

  it("stream end wakes blocked waiters and flips streamAlive to false", async () => {
    const stream = new FakeStream();
    const { sub } = buildSubscriber(stream);

    stream.push(message("op-5", OpControlSignal.OP_CONTROL_SIGNAL_PAUSE));
    const waiter = sub.waitForOp("op-5", { timeoutMs: 2000 });

    stream.end();
    await waiter;
    expect(sub.streamAlive()).toBe(false);

    sub.close();
  });

  it("waitForOp respects timeoutMs and resolves when no signal arrives", async () => {
    const stream = new FakeStream();
    const { sub } = buildSubscriber(stream);

    stream.push(message("op-6", OpControlSignal.OP_CONTROL_SIGNAL_PAUSE));
    const start = Date.now();
    await sub.waitForOp("op-6", { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    // 50ms target; allow up to 500ms under CI load.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);

    sub.close();
  });
});
