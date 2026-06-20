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

// grpc-js is imported for TYPES ONLY at module scope. Its runtime `credentials`
// value — and the `PolicyServiceClient` value from `./proto/generated/policy.js`,
// which itself imports `@grpc/grpc-js` — are loaded LAZILY via `await import(...)`
// on the real-connect path only (see `openRealChannel`). This keeps merely
// importing/exporting `OpControlSubscriber` (e.g. `import '@agent-assembly/sdk'`)
// from eagerly pulling `@grpc/grpc-js` at module-load time, which broke consumers
// where grpc-js isn't resolvable from this module's location (a `file:`-linked SDK
// under pnpm — the agent-assembly integration-tests node fixture). Regression from
// AAASM-3500; fix AAASM-3505.
import type { ChannelCredentials, ClientReadableStream } from "@grpc/grpc-js";

import { OpTerminatedError } from "./errors/op-terminated-error.js";
import type { AgentId } from "./proto/generated/common.js";
import type {
  OpControlMessage,
  OpControlSignal,
  PolicyServiceClient as PolicyServiceClientType
} from "./proto/generated/policy.js";

/**
 * Numeric `OpControlSignal` values, inlined to keep this module grpc-free at load.
 *
 * `OpControlSignal` lives in `./proto/generated/policy.js`, which imports
 * `@grpc/grpc-js` at module scope; importing the enum as a *value* would defeat
 * the lazy-load. These are the stable protobuf wire numbers (UNSPECIFIED=0,
 * PAUSE=1, RESUME=2, TERMINATE=3) — `msg.signal` is compared against them
 * numerically in {@link OpControlSubscriber.dispatch}. The `OpControlSignal`
 * type is still imported (type-only) for signatures.
 */
const SIGNAL_PAUSE: OpControlSignal = 1;
const SIGNAL_RESUME: OpControlSignal = 2;
const SIGNAL_TERMINATE: OpControlSignal = 3;

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
  opControlStream: (request: { agentId?: AgentId }) => ClientReadableStream<OpControlMessage>;
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
 * The slice of `@grpc/grpc-js`'s `credentials` namespace this module needs.
 * Injected into {@link resolveOpControlCredentials} so that module stays free of
 * a top-level grpc import — the real namespace is `await import`ed on connect.
 */
export interface GrpcCredentialsFactory {
  createInsecure: () => ChannelCredentials;
  createSsl: () => ChannelCredentials;
}

/**
 * Pick channel credentials for the op-control stream, secure by default.
 *
 * Precedence: an explicit `credentials` override wins; otherwise a loopback
 * target gets plaintext (local dev gateway), a remote target gets TLS, and a
 * remote target is only allowed plaintext when the caller sets `allowInsecure`.
 *
 * `grpcCredentials` is injected (rather than imported at module scope) so this
 * module does not eagerly load `@grpc/grpc-js` — see the module header. The
 * real-connect path passes the lazily-imported `credentials` namespace.
 *
 * @throws never — returns the chosen {@link ChannelCredentials}.
 */
export function resolveOpControlCredentials(
  gatewayUrl: string,
  opts: Pick<OpControlSubscriberOptions, "credentials" | "allowInsecure">,
  grpcCredentials: GrpcCredentialsFactory
): ChannelCredentials {
  if (opts.credentials) return opts.credentials;
  if (isLoopbackTarget(gatewayUrl)) return grpcCredentials.createInsecure();
  if (opts.allowInsecure) return grpcCredentials.createInsecure();
  return grpcCredentials.createSsl();
}

export class OpControlSubscriber {
  /**
   * `null` until the channel is opened. On the test-seam (`clientFactory`) path
   * it is set synchronously in {@link connect}; on the real-connect path it is
   * set asynchronously once `@grpc/grpc-js` + `PolicyServiceClient` have been
   * lazily imported (see {@link openRealChannel}).
   */
  private client: OpControlClient | null = null;
  private readonly agent: AgentId;
  private readonly ops = new Map<string, OpControlState>();
  private call: ClientReadableStream<OpControlMessage> | null = null;
  private alive = true;
  /** Set once {@link close} is called before the async channel finishes opening. */
  private closed = false;

  private constructor(agent: AgentId) {
    this.agent = agent;
  }

  /**
   * Open the gRPC channel + subscription stream and start the reader.
   *
   * Returns synchronously. On the real-connect path the channel is opened
   * asynchronously — `@grpc/grpc-js` and `PolicyServiceClient` are loaded lazily
   * (`await import`) so that importing this module never eagerly pulls grpc (see
   * the module header). The test seam (`clientFactory`) opens synchronously and
   * never touches grpc.
   */
  public static connect(gatewayUrl: string, opts: OpControlSubscriberOptions): OpControlSubscriber {
    const agent: AgentId = {
      orgId: opts.orgId,
      teamId: opts.teamId,
      agentId: opts.agentId
    };
    const subscriber = new OpControlSubscriber(agent);
    if (opts.clientFactory) {
      subscriber.client = opts.clientFactory();
      subscriber.start();
    } else {
      // Real channel: defer grpc loading to the dynamic-import path. Errors
      // surface as a dead stream so callers see `streamAlive() === false`.
      void subscriber.openRealChannel(gatewayUrl, opts).catch(() => {
        subscriber.markStreamDead();
      });
    }
    return subscriber;
  }

  /**
   * Lazily import grpc + the policy client, build the real client, and start the
   * reader. Kept off the module's import graph so `import '@agent-assembly/sdk'`
   * stays grpc-free until a subscriber actually opens a live channel.
   */
  private async openRealChannel(
    gatewayUrl: string,
    opts: OpControlSubscriberOptions
  ): Promise<void> {
    const { credentials } = await import("@grpc/grpc-js");
    const { PolicyServiceClient } = await import("./proto/generated/policy.js");
    if (this.closed) return; // close() raced ahead of the async open.
    this.client = new PolicyServiceClient(
      gatewayUrl,
      resolveOpControlCredentials(gatewayUrl, opts, credentials)
    ) as unknown as OpControlClient & PolicyServiceClientType;
    this.start();
  }

  /** Open the stream and wire reader handlers. Public so tests can call
   * directly after constructing with a hand-rolled client.
   */
  public start(): void {
    if (!this.client) return;
    this.call = this.client.opControlStream({ agentId: this.agent });
    this.call.on("data", (msg: OpControlMessage) => this.dispatch(msg));
    this.call.on("error", () => this.markStreamDead());
    this.call.on("end", () => this.markStreamDead());
  }

  private dispatch(msg: OpControlMessage): void {
    const state = this.slot(msg.opId);
    switch (msg.signal) {
      case SIGNAL_PAUSE:
        state.paused = true;
        break;
      case SIGNAL_RESUME:
        state.paused = false;
        this.flushResolvers(state);
        break;
      case SIGNAL_TERMINATE:
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
  public async waitForOp(opId: string, opts: { timeoutMs?: number } = {}): Promise<void> {
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

  /** Cancel the stream and clean up. Safe to call before the async real-channel
   * open has completed — it flags `closed` so the pending open bails out.
   */
  public close(): void {
    this.closed = true;
    this.call?.cancel();
    this.client?.close?.();
    this.markStreamDead();
  }
}
