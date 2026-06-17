/**
 * Gateway → SDK op-control consumer (AAASM-1422 PR-F / AAASM-1655).
 *
 * Subscribes to `PolicyService.OpControlStream` and exposes a per-`op_id`
 * cooperative-pause / fast-fail-terminate state machine through
 * {@link OpControlSubscriber.waitForOp}.
 *
 * State machine per op_id:
 * - `OP_CONTROL_SIGNAL_PAUSE`     → `waitForOp` blocks until RESUME arrives.
 * - `OP_CONTROL_SIGNAL_RESUME`    → `waitForOp` resolves immediately.
 * - `OP_CONTROL_SIGNAL_TERMINATE` → `waitForOp` rejects with `OpTerminatedError`.
 *
 * Signals that arrive for an `op_id` no one is currently awaiting are
 * buffered into the per-op slot so the next `waitForOp` sees them.
 *
 * Out of scope for PR-F (deferred):
 *   - Reconnection / heartbeat on stream close (caller observes
 *     `streamAlive` and re-instantiates if desired).
 *   - Auto-wiring into the existing `GatewayClient` / adapter hooks
 *     (separate sub-task when the adapter surface is stable).
 */

import {
  type ChannelCredentials,
  type ClientReadableStream,
  credentials as grpcCredentials,
} from "@grpc/grpc-js";

import { OpTerminatedError } from "./errors/op-terminated-error.js";
import type { AgentId } from "./proto/generated/common.js";
import {
  OpControlMessage,
  OpControlSignal,
  type PolicyServiceClient as PolicyServiceClientType,
  PolicyServiceClient,
} from "./proto/generated/policy.js";

/** Per-op state slot used by the cooperative-pause machine. */
interface OpControlState {
  paused: boolean;
  terminated: boolean;
  /** Resolves the next waiter when paused → resumed or anything → terminated. */
  resolvers: Array<() => void>;
}

/** Strip of the gRPC stub method the subscriber actually needs. Lets tests
 * mock the gRPC layer without standing up a server.
 */
export interface OpControlClient {
  opControlStream: (
    request: { agentId?: AgentId },
  ) => ClientReadableStream<OpControlMessage>;
  close?: () => void;
}

export interface OpControlSubscriberOptions {
  /** Composite identity of the subscribing agent. */
  orgId: string;
  teamId: string;
  agentId: string;
  /** Explicit credentials override. When supplied it is used verbatim and the
   * loopback / `allowInsecure` defaulting below is bypassed — the caller has
   * taken full responsibility for the transport (e.g. `createSsl(...)` with a
   * custom CA, or `createInsecure()` for an in-cluster sidecar).
   */
  credentials?: ChannelCredentials;
  /**
   * Permit a plaintext (`createInsecure`) channel to a **non-loopback**
   * gateway. Off by default: control-plane signals (pause / terminate) and the
   * agent identity triple travel this stream, so an unencrypted channel to a
   * remote host is opt-in only. Loopback targets stay plaintext without this
   * flag (local dev-mode gateway). Ignored when `credentials` is set.
   */
  allowInsecure?: boolean;
  /** Test seam — when supplied, skips opening a real gRPC channel and uses
   * this client directly. Used by the vitest tests.
   */
  clientFactory?: () => OpControlClient;
}

/**
 * Hosts treated as loopback for the secure-by-default transport decision.
 * A loopback gateway is the local dev-mode CP, where plaintext gRPC is the
 * documented default; anything else is presumed remote and must be encrypted.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Extract the bare host from a gRPC target (`host:port`, a bare host, or a
 * URL-style `scheme://host:port`). Returns the lowercased host with any
 * surrounding IPv6 brackets preserved so it can be matched against
 * {@link LOOPBACK_HOSTS}.
 */
export function gatewayHostOf(gatewayUrl: string): string {
  let target = gatewayUrl.trim();
  const schemeIdx = target.indexOf("://");
  if (schemeIdx !== -1) target = target.slice(schemeIdx + 3);
  // Drop a path/query suffix if a URL form was passed.
  const slashIdx = target.indexOf("/");
  if (slashIdx !== -1) target = target.slice(0, slashIdx);
  if (target.startsWith("[")) {
    // Bracketed IPv6: keep the bracketed form, strip only the trailing :port.
    const close = target.indexOf("]");
    return close === -1 ? target.toLowerCase() : target.slice(0, close + 1).toLowerCase();
  }
  const colonIdx = target.indexOf(":");
  if (colonIdx !== -1) target = target.slice(0, colonIdx);
  return target.toLowerCase();
}

function isLoopbackTarget(gatewayUrl: string): boolean {
  return LOOPBACK_HOSTS.has(gatewayHostOf(gatewayUrl));
}

/**
 * Pick channel credentials for the op-control stream, secure by default.
 *
 * Precedence: an explicit `credentials` override wins; otherwise a loopback
 * target gets plaintext (local dev gateway), a remote target gets TLS, and a
 * remote target is only allowed plaintext when the caller sets `allowInsecure`.
 *
 * @throws never — returns the chosen {@link ChannelCredentials}.
 */
export function resolveOpControlCredentials(
  gatewayUrl: string,
  opts: Pick<OpControlSubscriberOptions, "credentials" | "allowInsecure">,
): ChannelCredentials {
  if (opts.credentials) return opts.credentials;
  if (isLoopbackTarget(gatewayUrl)) return grpcCredentials.createInsecure();
  if (opts.allowInsecure) return grpcCredentials.createInsecure();
  return grpcCredentials.createSsl();
}

export class OpControlSubscriber {
  private readonly client: OpControlClient;
  private readonly agent: AgentId;
  private readonly ops = new Map<string, OpControlState>();
  private call: ClientReadableStream<OpControlMessage> | null = null;
  private alive = true;

  private constructor(client: OpControlClient, agent: AgentId) {
    this.client = client;
    this.agent = agent;
  }

  /** Open the gRPC channel + subscription stream and start the reader. */
  public static connect(
    gatewayUrl: string,
    opts: OpControlSubscriberOptions,
  ): OpControlSubscriber {
    const agent: AgentId = {
      orgId: opts.orgId,
      teamId: opts.teamId,
      agentId: opts.agentId,
    };
    const client = opts.clientFactory
      ? opts.clientFactory()
      : (new PolicyServiceClient(
          gatewayUrl,
          resolveOpControlCredentials(gatewayUrl, opts),
        ) as unknown as OpControlClient & PolicyServiceClientType);
    const subscriber = new OpControlSubscriber(client, agent);
    subscriber.start();
    return subscriber;
  }

  /** Open the stream and wire reader handlers. Public so tests can call
   * directly after constructing with a hand-rolled client.
   */
  public start(): void {
    this.call = this.client.opControlStream({ agentId: this.agent });
    this.call.on("data", (msg: OpControlMessage) => this.dispatch(msg));
    this.call.on("error", () => this.markStreamDead());
    this.call.on("end", () => this.markStreamDead());
  }

  private dispatch(msg: OpControlMessage): void {
    const state = this.slot(msg.opId);
    switch (msg.signal) {
      case OpControlSignal.OP_CONTROL_SIGNAL_PAUSE:
        state.paused = true;
        break;
      case OpControlSignal.OP_CONTROL_SIGNAL_RESUME:
        state.paused = false;
        this.flushResolvers(state);
        break;
      case OpControlSignal.OP_CONTROL_SIGNAL_TERMINATE:
        state.terminated = true;
        this.flushResolvers(state);
        break;
      default:
        // UNSPECIFIED / UNRECOGNIZED — drop on the floor.
        break;
    }
  }

  private slot(opId: string): OpControlState {
    let state = this.ops.get(opId);
    if (!state) {
      state = { paused: false, terminated: false, resolvers: [] };
      this.ops.set(opId, state);
    }
    return state;
  }

  private flushResolvers(state: OpControlState): void {
    const pending = state.resolvers;
    state.resolvers = [];
    for (const resolve of pending) resolve();
  }

  private markStreamDead(): void {
    this.alive = false;
    // Wake any blocked waiters so they can re-check state.
    for (const state of this.ops.values()) this.flushResolvers(state);
  }

  /**
   * Block until `opId` is runnable, or reject on terminate.
   *
   * Resolves immediately when the op is not currently paused. When paused,
   * waits up to `timeoutMs` for a resume signal. Rejects with
   * {@link OpTerminatedError} if the op has been (or becomes) terminated.
   *
   * A timeout resolves normally — the caller can inspect {@link isPaused}
   * or retry. Matches the cooperative-pause expectation in the architecture
   * doc (the SDK yields, it doesn't deadline-enforce).
   */
  public async waitForOp(
    opId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<void> {
    const state = this.slot(opId);
    if (state.terminated) {
      throw new OpTerminatedError(`op ${opId} was terminated by the gateway`, opId);
    }
    if (!state.paused) return;

    await new Promise<void>((resolve) => {
      state.resolvers.push(resolve);
      if (opts.timeoutMs !== undefined) {
        setTimeout(() => {
          // Remove this resolver from the queue + resolve so the await unblocks.
          const idx = state.resolvers.indexOf(resolve);
          if (idx !== -1) state.resolvers.splice(idx, 1);
          resolve();
        }, opts.timeoutMs);
      }
    });

    if (state.terminated) {
      throw new OpTerminatedError(`op ${opId} was terminated by the gateway`, opId);
    }
  }

  public isPaused(opId: string): boolean {
    return this.ops.get(opId)?.paused ?? false;
  }

  public isTerminated(opId: string): boolean {
    return this.ops.get(opId)?.terminated ?? false;
  }

  public streamAlive(): boolean {
    return this.alive;
  }

  /** Cancel the stream and clean up. */
  public close(): void {
    this.call?.cancel();
    this.client.close?.();
    this.markStreamDead();
  }
}
