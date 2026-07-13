import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveAgentKeypair, resolveRegistrationDid } from "../src/native/keypair.js";

/**
 * AAASM-4468 — cross-language conformance for the deterministic keypair
 * derivation. These vectors were emitted by the authoritative Rust
 * `aa-sdk-client` crate (`AgentKeypair`), so matching them byte-for-byte proves
 * the Node SDK derives the exact same seed / public key / `did:key` / signature
 * the gateway expects. A wrong derivation would silently fail the gateway's
 * possession-proof check at register time, so this is the load-bearing test.
 */

interface GoldenVector {
  agent_id: string;
  seed_hex: string;
  public_key_hex: string;
  did_key: string;
  nonce_signature_hex: string;
}

interface GoldenFixture {
  nonce_hex: string;
  vectors: GoldenVector[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/keypair-golden-vectors.json", import.meta.url)), "utf8")
) as GoldenFixture;

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("deriveAgentKeypair conformance against Rust golden vectors (AAASM-4468)", () => {
  const nonce = Buffer.from(fixture.nonce_hex, "hex");

  for (const vector of fixture.vectors) {
    it(`matches the Rust derivation for "${vector.agent_id}"`, async () => {
      const keypair = await deriveAgentKeypair(vector.agent_id);

      expect(toHex(keypair.seed)).toBe(vector.seed_hex);
      expect(keypair.publicKeyHex).toBe(vector.public_key_hex);
      expect(keypair.publicKeyHex).toHaveLength(64);
      expect(keypair.didKey).toBe(vector.did_key);

      // Ed25519 is deterministic (RFC 8032), so the possession proof over a
      // fixed nonce is a stable known-answer value.
      const signature = await keypair.sign(nonce);
      expect(toHex(signature)).toBe(vector.nonce_signature_hex);
      expect(signature).toHaveLength(64);
    });
  }

  it("is deterministic: the same identifier yields the same key", async () => {
    const a = await deriveAgentKeypair("agent-a");
    const b = await deriveAgentKeypair("agent-a");
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(a.didKey).toBe(b.didKey);
  });

  it("distinct identifiers yield distinct keys", async () => {
    const a = await deriveAgentKeypair("agent-a");
    const b = await deriveAgentKeypair("agent-b");
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });
});

describe("resolveRegistrationDid (AAASM-4468)", () => {
  it("derives a did:key for a plain identifier", async () => {
    const keypair = await deriveAgentKeypair("my-agent");
    expect(resolveRegistrationDid("my-agent", keypair)).toBe(keypair.didKey);
    expect(resolveRegistrationDid("my-agent", keypair)).toMatch(/^did:key:z/);
  });

  it("passes an already-did:key identifier through unchanged", async () => {
    const keypair = await deriveAgentKeypair("did:key:zAlreadyDid");
    // Passthrough returns the caller's DID verbatim — NOT the derived did:key.
    expect(resolveRegistrationDid("did:key:zAlreadyDid", keypair)).toBe("did:key:zAlreadyDid");
    expect(resolveRegistrationDid("did:key:zAlreadyDid", keypair)).not.toBe(keypair.didKey);
  });
});
