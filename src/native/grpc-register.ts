import { ChannelCredentials, Metadata, type ServiceError } from "@grpc/grpc-js";
import { AgentLifecycleServiceClient } from "../proto/generated/agent.js";
import type { ChallengeResponse, RegisterRequest, RegisterResponse } from "../proto/generated/agent.js";
import { EnforcementMode, RiskTier } from "../proto/generated/common.js";
import { deriveAgentKeypair, resolveRegistrationDid } from "./keypair.js";
import type { RegisterOptions } from "./client.js";

/**
 * Pure-JS gateway registration transport for the default `grpc-sidecar` mode
 * (AAASM-4468).
 *
 * The gateway serves `AgentLifecycleService` over gRPC on `:50051` in
 * `aasm start --mode local`, but the `grpc-sidecar` native client's `register`
 * was a hardcoded no-op stub, so a documented quick-start agent never actually
 * registered (no error, no dashboard entry). This module dials that gRPC service
 * directly in pure TypeScript — no native binding required — running the
 * possession-proof handshake byte-for-byte compatible with the Rust
 * `aa-sdk-client` gateway client:
 *
 *   `RequestChallenge{agent_id, public_key}` → server nonce → sign the raw nonce
 *   → `Register{…, possession_proof, registration_nonce}` → `credential_token` +
 *   `assigned_policy`.
 *
 * This is the SDK layer of the three-layer model and remains **advisory**: a
 * failed registration is surfaced as a rejected promise (init warns and proceeds
 * unregistered), never a hard failure — the proxy / eBPF layers stay
 * authoritative.
 */

/** Default gRPC endpoint of the gateway's `AgentLifecycleService` (`:50051`). */
const DEFAULT_GATEWAY_ENDPOINT = "http://127.0.0.1:50051";

/**
 * Per-call deadline (ms) for the challenge and register RPCs. Bounds init so a
 * missing / unreachable gateway fails fast into the "proceeding unregistered"
 * warning rather than hanging the agent's startup.
 */
const REGISTER_TIMEOUT_MS = 5000;

/**
 * Resolve the gRPC endpoint for the lifecycle service. Mirrors the Rust
 * `resolve_gateway_endpoint` env/default precedence — `AA_GATEWAY_ENDPOINT` then
 * the `:50051` default. Deliberately independent of the SDK's `gatewayUrl`,
 * which addresses the REST/control-plane surface (`:7391`), a different port
 * with no gRPC.
 */
function resolveGrpcEndpoint(): string {
  const fromEnv = process.env.AA_GATEWAY_ENDPOINT;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_GATEWAY_ENDPOINT;
}

/**
 * Split a `http(s)://host:port` endpoint into the `host:port` authority grpc-js
 * expects and matching channel credentials (TLS for `https`, insecure
 * otherwise).
 */
function grpcTarget(endpoint: string): { address: string; credentials: ChannelCredentials } {
  const useTls = endpoint.startsWith("https://");
  const address = endpoint.replace(/^https?:\/\//, "");
  return {
    address,
    credentials: useTls ? ChannelCredentials.createSsl() : ChannelCredentials.createInsecure()
  };
}

/** Promisify a grpc-js unary call, applying the shared per-call deadline. */
function unary<Res>(
  invoke: (metadata: Metadata, options: { deadline: number }, callback: (error: ServiceError | null, response: Res) => void) => void
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    invoke(new Metadata(), { deadline: Date.now() + REGISTER_TIMEOUT_MS }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Register the agent with the gateway over gRPC and return the assigned policy
 * id. Runs the full challenge → sign → register handshake, then closes the
 * client. Rejects (never throws synchronously) if the gateway is unreachable or
 * rejects the possession proof — the caller (`initAssembly`) maps that onto the
 * advisory "proceeding unregistered" warning.
 *
 * `sdkVersion` is signed into `RegisterRequest.version`; when absent the field
 * is left empty (the gateway does not require it).
 */
export async function registerViaGrpc(options: RegisterOptions, sdkVersion?: string): Promise<string> {
  const endpoint = resolveGrpcEndpoint();
  const { address, credentials } = grpcTarget(endpoint);
  const client = new AgentLifecycleServiceClient(address, credentials);

  try {
    const keypair = await deriveAgentKeypair(options.agentId);
    const registrationDid = resolveRegistrationDid(options.agentId, keypair);
    const agentId = {
      orgId: "",
      teamId: options.teamId ?? "",
      agentId: registrationDid
    };

    const challenge = await unary<ChallengeResponse>((metadata, callOptions, callback) =>
      client.requestChallenge(
        { agentId, publicKey: keypair.publicKeyHex },
        metadata,
        callOptions,
        callback
      )
    );

    const nonce = Buffer.from(challenge.nonce);
    const possessionProof = Buffer.from(await keypair.sign(nonce));

    const request: RegisterRequest = {
      agentId,
      name: options.name,
      framework: options.framework,
      version: sdkVersion ?? "",
      riskTier: RiskTier.RISK_UNSPECIFIED,
      toolNames: [],
      publicKey: keypair.publicKeyHex,
      metadata: {},
      enforcementMode: EnforcementMode.ENFORCEMENT_MODE_UNSPECIFIED,
      possessionProof,
      registrationNonce: nonce,
      ...(options.parentAgentId !== undefined ? { parentAgentId: options.parentAgentId } : {})
    };

    const response = await unary<RegisterResponse>((metadata, callOptions, callback) =>
      client.register(request, metadata, callOptions, callback)
    );

    return response.assignedPolicy;
  } finally {
    client.close();
  }
}
