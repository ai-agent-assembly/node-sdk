/**
 * Reusable enforcement-truth negative-control fixture (AAASM-5529).
 *
 * A test that only asserts "a `PolicyViolationError` was thrown" proves the SDK
 * printed a refusal, not that the refusal *prevented* anything: a tool whose
 * body never had an observable effect in the first place would produce the same
 * green result. These helpers give a denied tool a real, externally-observable
 * side effect — a file written to disk, an HTTP request delivered to a live
 * listener — so a deny can be asserted as an *absence of the effect*, and the
 * matching allow can be asserted as its *presence*.
 *
 * Every control built on this fixture must be used as a pair:
 *
 *   - **positive control** — policy allows, the side effect is observed. Without
 *     it, "no file on disk" is indistinguishable from "the tool was never called
 *     at all", and the negative control proves nothing.
 *   - **negative control** — policy denies, the same side effect is absent.
 *
 * The side effects are deliberately real (`node:fs`, `node:http`) rather than
 * spies: a spy records an intent to act, and the whole point of this Epic
 * (AAASM-5526) is that intent-level evidence is what over-claimed enforcement
 * looks like.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import type { GatewayClient } from "../../src/gateway/client.js";
import type {
  GatewayCheckRequest,
  GatewayDecision,
  GatewayRecordEvent,
  GatewayResultRecord
} from "../../src/types/gateway-governance.js";

/**
 * A filesystem-backed side effect: `write` really creates a file, `occurred`
 * really stats it. Nothing is mocked, so an assertion over `occurred()` is an
 * assertion over the world, not over the SDK's own bookkeeping.
 */
export interface FileSideEffect {
  /** Absolute path the governed tool would create. */
  readonly path: string;
  /** Perform the side effect (what a denied tool must never reach). */
  write: (content: string) => Promise<string>;
  /** Whether the side effect is observable on disk right now. */
  occurred: () => boolean;
  /** Content actually written, or `undefined` when the effect never occurred. */
  content: () => string | undefined;
  cleanup: () => void;
}

export function createFileSideEffect(name = "denied-write.txt"): FileSideEffect {
  const dir = mkdtempSync(join(tmpdir(), "aaasm-5529-"));
  const path = join(dir, name);
  return {
    path,
    write: async (content: string) => {
      await writeFile(path, content, "utf8");
      return path;
    },
    occurred: () => existsSync(path),
    content: () => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

/**
 * A network-backed side effect: a real loopback HTTP server that records every
 * request it receives. A denied tool must leave `requests()` empty — the
 * strongest available in-process evidence that the egress the tool would have
 * performed never left the process.
 */
export interface NetworkSideEffect {
  /** URL the governed tool would call. */
  readonly url: string;
  /** Perform the side effect (what a denied tool must never reach). */
  call: (body: string) => Promise<number>;
  /** Requests the listener actually received, in arrival order. */
  requests: () => readonly { method: string; url: string; body: string }[];
  /** Whether any request reached the listener. */
  occurred: () => boolean;
  close: () => Promise<void>;
}

export async function createNetworkSideEffect(): Promise<NetworkSideEffect> {
  const received: { method: string; url: string; body: string }[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8")
      });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/exfiltrate`;

  return {
    url,
    call: async (body: string) => {
      const response = await fetch(url, { method: "POST", body });
      return response.status;
    },
    requests: () => received,
    occurred: () => received.length > 0,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

/**
 * One governance decision as the fixture gateway recorded it, carrying only
 * values the SDK itself supplied in its {@link GatewayCheckRequest}.
 *
 * Nothing here is echoed back from the fixture's own construction. A field the
 * fixture populated from its own constructor argument would compare equal no
 * matter what the SDK sent, so an assertion over it could never fail — the
 * exact shape of vacuous evidence this Epic (AAASM-5526) exists to eliminate.
 * That is why there is no `agentId`: the SDK does not send one on the check
 * path, so the fixture cannot observe one. See the pinning test in
 * `quickstart-negative-control.test.ts`.
 */
export interface RecordedCheck {
  readonly toolName: string | undefined;
  readonly action: string;
  readonly runId: string;
  readonly denied: boolean;
}

/**
 * Policy-driven {@link GatewayClient} standing in for the quick-start's
 * `createPolicyGatewayClient()` (docs/02-quick-start, `withAssembly(..., {
 * gatewayClient })`). It denies exactly the named tools and records the
 * verbatim outbound requests, the resulting decisions, and every audit event,
 * so a test can assert what a deny was actually attributed to.
 *
 * It deliberately accepts no `agentId`: the SDK puts no agent identity on the
 * check path, so a fixture that took one could only hand it straight back.
 */
export interface PolicyGatewayClient extends GatewayClient {
  readonly decisions: readonly RecordedCheck[];
  /**
   * Every {@link GatewayCheckRequest} the SDK passed to `check`, verbatim and
   * unmodified. Asserting over this — rather than over anything the fixture
   * derived — is the only way a control can state what identity the SDK does,
   * and does not, attribute a policy check to.
   */
  readonly checkRequests: readonly GatewayCheckRequest[];
  readonly auditEvents: readonly GatewayRecordEvent[];
  readonly auditResults: readonly GatewayResultRecord[];
}

/**
 * A {@link GatewayClient} whose `check` returns `pending` and whose approval is
 * then rejected — the second refusal route through `enforceGovernance`, which
 * emits a different audit action from a straight policy deny.
 */
export function createPendingThenRejectGatewayClient(): PolicyGatewayClient {
  const decisions: RecordedCheck[] = [];
  const checkRequests: GatewayCheckRequest[] = [];
  const auditEvents: GatewayRecordEvent[] = [];
  const auditResults: GatewayResultRecord[] = [];

  return {
    mode: "sdk-only",
    decisions,
    checkRequests,
    auditEvents,
    auditResults,
    start: async () => undefined,
    close: async () => undefined,
    check: async (request: GatewayCheckRequest): Promise<GatewayDecision> => {
      checkRequests.push(request);
      decisions.push({
        toolName: request.toolName,
        action: request.action,
        runId: request.runId,
        denied: false
      });
      return { denied: false, pending: true };
    },
    waitForApproval: async () => ({ denied: true, reason: "approver said no" }),
    record: async (event: GatewayRecordEvent) => {
      auditEvents.push(event);
    },
    recordResult: async (record: GatewayResultRecord) => {
      auditResults.push(record);
    },
    scanPrompts: async () => undefined
  };
}

/** A denying {@link GatewayClient} whose audit `record` always fails. */
export interface FailingRecordGatewayClient extends GatewayClient {
  /** How many times `record` was entered, so a test can tell "failed" from "never called". */
  readonly recordAttempts: number;
}

/**
 * A denying client whose `record` fails in one of two shapes.
 *
 * `sync-throw` is the load-bearing one: it throws *before* returning a promise,
 * so a trailing `.catch()` on the return value never sees it. Only a
 * `try`/`catch` around the call contains it.
 */
export function createFailingRecordGatewayClient(
  mode: "async-reject" | "sync-throw"
): FailingRecordGatewayClient {
  let attempts = 0;
  return {
    mode: "sdk-only",
    get recordAttempts() {
      return attempts;
    },
    start: async () => undefined,
    close: async () => undefined,
    check: async (request: GatewayCheckRequest): Promise<GatewayDecision> => ({
      denied: true,
      pending: false,
      reason: `tool '${request.toolName}' is denied by policy`
    }),
    waitForApproval: async () => ({ denied: true }),
    record: (() => {
      attempts += 1;
      if (mode === "sync-throw") {
        throw new Error("audit sink down (sync)");
      }
      return Promise.reject(new Error("audit sink down (async)"));
    }) as GatewayClient["record"],
    recordResult: async () => undefined,
    scanPrompts: async () => undefined
  };
}

export function createPolicyGatewayClient(options: {
  denyTools: readonly string[];
}): PolicyGatewayClient {
  const decisions: RecordedCheck[] = [];
  const checkRequests: GatewayCheckRequest[] = [];
  const auditEvents: GatewayRecordEvent[] = [];
  const auditResults: GatewayResultRecord[] = [];
  const denied = new Set(options.denyTools);

  return {
    mode: "sdk-only",
    decisions,
    checkRequests,
    auditEvents,
    auditResults,
    start: async () => undefined,
    close: async () => undefined,
    check: async (request: GatewayCheckRequest): Promise<GatewayDecision> => {
      const isDenied = request.toolName !== undefined && denied.has(request.toolName);
      checkRequests.push(request);
      decisions.push({
        toolName: request.toolName,
        action: request.action,
        runId: request.runId,
        denied: isDenied
      });
      return isDenied
        ? { denied: true, pending: false, reason: `tool '${request.toolName}' is denied by policy` }
        : { denied: false, pending: false };
    },
    waitForApproval: async () => ({ denied: false }),
    record: async (event: GatewayRecordEvent) => {
      auditEvents.push(event);
    },
    recordResult: async (record: GatewayResultRecord) => {
      auditResults.push(record);
    },
    scanPrompts: async () => undefined
  };
}
