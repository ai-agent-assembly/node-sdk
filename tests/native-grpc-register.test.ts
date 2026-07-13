import { createPublicKey, verify as edVerify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAgentKeypair } from "../src/native/keypair.js";

/**
 * Fixed SPKI DER header for an Ed25519 public key whose 32-byte raw key follows.
 * Wrapping the derived raw public key with it lets `node:crypto` verify the
 * possession proof independently — no third-party Ed25519 dependency in tests.
 */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519PublicKeyFromRaw(raw: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki"
  });
}

/**
 * AAASM-4468 — the pure-JS `grpc-sidecar` registration transport. These tests
 * mock the generated `AgentLifecycleServiceClient` so no real socket is opened,
 * and assert that `registerViaGrpc` constructs the challenge/register messages
 * exactly as the gateway's possession-proof handshake requires:
 *   - the challenge and register carry the derived `did:key` + hex public key;
 *   - the `possession_proof` is a valid Ed25519 signature over the *server
 *     nonce* (not the did), and the nonce is echoed back verbatim;
 *   - metadata fields (name / framework / version / lineage) round-trip.
 */

const NONCE = Buffer.from("11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff", "hex");

const captured = vi.hoisted(() => ({
  address: "",
  closed: false,
  challengeReq: undefined as unknown,
  registerReq: undefined as unknown
}));

vi.mock("../src/proto/generated/agent.js", () => ({
  AgentLifecycleServiceClient: class {
    constructor(address: string) {
      captured.address = address;
    }
    requestChallenge(
      request: unknown,
      _metadata: unknown,
      _options: unknown,
      callback: (error: null, response: unknown) => void
    ): void {
      captured.challengeReq = request;
      callback(null, { nonce: NONCE, expiresAtUnixMs: Date.now() + 60000 });
    }
    register(
      request: unknown,
      _metadata: unknown,
      _options: unknown,
      callback: (error: null, response: unknown) => void
    ): void {
      captured.registerReq = request;
      callback(null, { credentialToken: "tok-123", assignedPolicy: "policy-abc", heartbeatIntervalSec: 30 });
    }
    close(): void {
      captured.closed = true;
    }
  }
}));

interface CapturedAgentId {
  orgId: string;
  teamId: string;
  agentId: string;
}
interface CapturedRegister {
  agentId: CapturedAgentId;
  name: string;
  framework: string;
  version: string;
  riskTier: number;
  enforcementMode: number;
  toolNames: string[];
  metadata: Record<string, string>;
  publicKey: string;
  possessionProof: Buffer;
  registrationNonce: Buffer;
  parentAgentId?: string;
}

describe("registerViaGrpc handshake construction (AAASM-4468)", () => {
  const OLD_ENDPOINT = process.env.AA_GATEWAY_ENDPOINT;

  afterEach(() => {
    if (OLD_ENDPOINT === undefined) {
      delete process.env.AA_GATEWAY_ENDPOINT;
    } else {
      process.env.AA_GATEWAY_ENDPOINT = OLD_ENDPOINT;
    }
    captured.challengeReq = undefined;
    captured.registerReq = undefined;
    captured.closed = false;
  });

  it("signs the server nonce and carries the derived identity", async () => {
    process.env.AA_GATEWAY_ENDPOINT = "http://gw.test:50051";
    const { registerViaGrpc } = await import("../src/native/grpc-register.js");

    const assignedPolicy = await registerViaGrpc(
      { agentId: "agent-z", name: "Agent Z", framework: "langchain-js", teamId: "team-1" },
      "9.9.9"
    );

    expect(assignedPolicy).toBe("policy-abc");
    // Endpoint scheme is stripped to the host:port authority grpc-js expects.
    expect(captured.address).toBe("gw.test:50051");
    expect(captured.closed).toBe(true);

    const keypair = await deriveAgentKeypair("agent-z");
    const challenge = captured.challengeReq as { agentId: CapturedAgentId; publicKey: string };
    expect(challenge.agentId).toEqual({ orgId: "", teamId: "team-1", agentId: keypair.didKey });
    expect(challenge.publicKey).toBe(keypair.publicKeyHex);

    const register = captured.registerReq as CapturedRegister;
    expect(register.agentId).toEqual({ orgId: "", teamId: "team-1", agentId: keypair.didKey });
    expect(register.name).toBe("Agent Z");
    expect(register.framework).toBe("langchain-js");
    expect(register.version).toBe("9.9.9");
    expect(register.riskTier).toBe(0);
    expect(register.enforcementMode).toBe(0);
    expect(register.toolNames).toEqual([]);
    expect(register.metadata).toEqual({});
    expect(register.publicKey).toBe(keypair.publicKeyHex);

    // The nonce is echoed verbatim and the proof verifies over it under the
    // derived public key — this is exactly what the gateway re-checks.
    expect(Buffer.from(register.registrationNonce).equals(NONCE)).toBe(true);
    expect(register.possessionProof).toHaveLength(64);
    const verified = edVerify(
      null,
      new Uint8Array(NONCE),
      ed25519PublicKeyFromRaw(keypair.publicKey),
      new Uint8Array(register.possessionProof)
    );
    expect(verified).toBe(true);
  });

  it("passes an already-did:key agentId through unchanged and forwards parent lineage", async () => {
    delete process.env.AA_GATEWAY_ENDPOINT;
    const { registerViaGrpc } = await import("../src/native/grpc-register.js");

    await registerViaGrpc({
      agentId: "did:key:zAlreadyDid",
      name: "child",
      framework: "none",
      parentAgentId: "11111111-2222-3333-4444-555555555555"
    });

    // Default endpoint (:50051) when AA_GATEWAY_ENDPOINT is unset.
    expect(captured.address).toBe("127.0.0.1:50051");
    const register = captured.registerReq as CapturedRegister;
    expect(register.agentId.agentId).toBe("did:key:zAlreadyDid");
    expect(register.agentId.teamId).toBe("");
    expect(register.parentAgentId).toBe("11111111-2222-3333-4444-555555555555");
  });
});
