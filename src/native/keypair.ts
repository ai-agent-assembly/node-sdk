import { createHash } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import bs58 from "bs58";

/**
 * Deterministic Ed25519 keypair derivation for gateway registration
 * (AAASM-4468).
 *
 * The gateway's `AgentLifecycleService.Register` requires *both* a
 * syntactically-valid `did:key` agent identity *and* a real Ed25519 `public_key`
 * (32 bytes, lowercase hex) that decodes to the same key. SDKs configure agents
 * with a human-readable identifier rather than a provisioned keypair, so this
 * module derives a **deterministic** keypair from that identifier: the same
 * agent id always yields the same keypair, giving a stable identity across
 * process restarts without persisting key material.
 *
 * The derivation must stay **byte-for-byte identical** to the Rust
 * `aa-sdk-client` crate (`keypair.rs` / `identity.rs`) so an agent registered
 * from the Node SDK and the same agent registered from any other SDK resolve to
 * the same gateway identity:
 *   - seed        = `SHA-256(identifier_utf8)` (32 bytes)
 *   - signing key = Ed25519 `from_bytes(seed)` (the SHA-256 digest *is* the
 *                   RFC 8032 32-byte secret seed)
 *   - public key  = the derived 32-byte verifying key
 *   - `did:key`   = `did:key:z` + base58btc(`0xed 0x01` ‖ public key)
 */

/**
 * Multicodec prefix for an Ed25519 public key (`0xed`), varint-encoded as the
 * two bytes `0xed 0x01`. An Ed25519 `did:key` is the base58btc multibase
 * encoding of these two bytes followed by the 32-byte verifying key.
 */
const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

/** A deterministic Ed25519 keypair derived from an agent identifier. */
export interface AgentKeypair {
  /** The 32-byte SHA-256 seed the signing key was derived from. */
  readonly seed: Uint8Array;
  /** The 32-byte Ed25519 verifying (public) key. */
  readonly publicKey: Uint8Array;
  /** The verifying key as 64 lowercase hex chars — the gateway's `public_key`. */
  readonly publicKeyHex: string;
  /** The canonical Ed25519 `did:key:z…` for this keypair. */
  readonly didKey: string;
  /**
   * Sign `message` with the agent's Ed25519 signing key, returning the raw
   * 64-byte signature. Used to prove key possession over the server-issued
   * registration nonce. Async because it derives the SHA-512 the Ed25519
   * signature needs via WebCrypto (no ambient hash configuration required).
   */
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Build the canonical Ed25519 `did:key` for a 32-byte verifying key: the
 * base58btc multibase (`z` prefix) of `0xed 0x01` followed by the key. Binds the
 * DID to the same key the gateway receives in the `public_key` field.
 */
function didKeyForPublicKey(publicKey: Uint8Array): string {
  const multicodec = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  multicodec.set(ED25519_MULTICODEC_PREFIX, 0);
  multicodec.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${bs58.encode(multicodec)}`;
}

/**
 * Derive the deterministic {@link AgentKeypair} for `identifier`.
 *
 * The seed is `SHA-256(identifier)` (always 32 bytes), a valid Ed25519 secret
 * seed, so derivation never fails.
 */
export async function deriveAgentKeypair(identifier: string): Promise<AgentKeypair> {
  const seed = new Uint8Array(createHash("sha256").update(identifier, "utf8").digest());
  const publicKey = await ed25519.getPublicKeyAsync(seed);
  const publicKeyHex = Buffer.from(publicKey).toString("hex");
  const didKey = didKeyForPublicKey(publicKey);
  return {
    seed,
    publicKey,
    publicKeyHex,
    didKey,
    sign: (message: Uint8Array) => ed25519.signAsync(message, seed)
  };
}

/**
 * Resolve the `agent_id` DID the agent registers under (mirrors the Rust
 * `identity::agent_id_to_did_key`): pass an already-`did:key` identifier through
 * unchanged so an explicitly-provisioned DID is preserved, otherwise use the
 * keypair's derived `did:key`. The `public_key` is always the keypair's derived
 * key regardless.
 */
export function resolveRegistrationDid(identifier: string, keypair: AgentKeypair): string {
  return identifier.startsWith("did:key:") ? identifier : keypair.didKey;
}
