//! Thin napi-rs shim over the shared [`aa_sdk_client`] runtime client.
//!
//! All transport, IPC wire codec, [`AssemblyClient`] lifecycle, and advisory
//! credential preflight live in `aa-sdk-client`; this crate only translates
//! between the Node/napi world and that shared client so the runtime-client
//! logic cannot drift between the language SDKs.
//!
//! The SDK is **not** a security boundary. The mandatory runtime chokepoint
//! (`aa-runtime`, AAASM-2568) re-scans, re-redacts, and normalizes every event
//! authoritatively, so this shim holds **no** authoritative scanning, redaction,
//! or policy-decision logic — it captures events and ships them.

use std::sync::Arc;

use aa_proto::assembly::common::v1::{ActionType, AgentId, Decision};
use aa_proto::assembly::policy::v1::{
  action_context, ActionContext, CheckActionRequest, ToolCallContext,
};
use aa_sdk_client::ipc::spawn_ipc_thread;
use aa_sdk_client::{AssemblyClient, AssemblyConfig, SdkClientError};
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use serde_json::Value;

const ERR_CONNECT: &str = "AA_ERR_CONNECT";
const ERR_REGISTER: &str = "AA_ERR_REGISTER";
const ERR_SEND_EVENT: &str = "AA_ERR_SEND_EVENT";
const ERR_DISCONNECT: &str = "AA_ERR_DISCONNECT";
const ERR_QUERY_POLICY: &str = "AA_ERR_QUERY_POLICY";

/// Reason attached to a fail-open `allow` when the runtime does not answer.
///
/// The SDK is advisory, not a security boundary: an unreachable or slow
/// `aa-runtime` must never block the agent (the proxy / eBPF layers remain
/// authoritative), so a [`SdkClientError::QueryFailed`] is surfaced as an
/// `allow` rather than a hard error.
const FAIL_OPEN_REASON: &str = "aa-runtime unreachable or slow; failing open (advisory SDK)";

/// Handle to an active Agent Assembly session, wrapping the shared
/// [`AssemblyClient`]. The inner `Arc` keeps napi calls cheap and lets the
/// async `disconnect` move a clone onto a blocking task.
#[napi]
pub struct ClientHandle {
  inner: Arc<AssemblyClient>,
}

/// Connect to the `aa-runtime` Unix-domain socket and open a session.
///
/// Socket resolution, the background IPC thread, and the wire codec are all
/// delegated to `aa-sdk-client`; this shim only validates the argument and
/// wraps the resulting client.
///
/// `agentId` is the agent identity the background thread signs the runtime
/// session handshake with (AAASM-3587). `sdkVersion` is the user-facing npm
/// package version (`@agent-assembly/sdk`) the JS layer forwards so it — not the
/// shared `aa-sdk-client` crate version — is what gets signed into the handshake
/// proof (AAASM-3683); `undefined` falls back to the crate version (no
/// regression vs AAASM-3666).
#[napi]
pub async fn connect(
  socket_path: String,
  agent_id: Option<String>,
  sdk_version: Option<String>,
) -> Result<ClientHandle> {
  if socket_path.trim().is_empty() {
    return Err(typed_error(ERR_CONNECT, "socketPath cannot be empty"));
  }

  let config = AssemblyConfig {
    agent_id: agent_id.unwrap_or_default(),
    socket_path: Some(socket_path),
    gateway_endpoint: None,
    team_id: None,
    parent_agent_id: None,
    sdk_version,
  };
  let resolved = config.resolve_socket_path();

  let ipc = spawn_ipc_thread(resolved, config.agent_id.clone(), config.resolved_sdk_version())
    .map_err(|err| typed_error(ERR_CONNECT, &err.to_string()))?;
  let client = AssemblyClient::new(ipc, Vec::new());

  Ok(ClientHandle {
    inner: Arc::new(client),
  })
}

/// Parameters for [`register`].
///
/// `agentId` is the agent identity the gateway registers (derived into a
/// `did:key` + Ed25519 public key by the shared client). `name` and `framework`
/// are descriptive metadata the gateway records. `gatewayEndpoint` overrides the
/// gateway gRPC endpoint (default resolved from `AA_GATEWAY_ENDPOINT` or
/// `http://127.0.0.1:50051`).
///
/// `teamId` and `parentAgentId` carry the agent's lineage/team scoping to the
/// gateway on register (AAASM-3415): `teamId` drives team-budget attribution
/// and `parentAgentId` the topology graph. Both are optional — omit for a
/// team-unscoped / root agent.
#[napi(object)]
pub struct RegisterOptions {
  pub agent_id: String,
  pub name: String,
  pub framework: String,
  pub gateway_endpoint: Option<String>,
  pub team_id: Option<String>,
  pub parent_agent_id: Option<String>,
}

/// Register this agent with the governance gateway and store the issued
/// credential token on the session.
///
/// This is the **only** direct SDK→gateway gRPC call (per ADR 0004);
/// `CheckAction` still flows through `aa-runtime`. The token the gateway issues
/// is stored inside the shared [`AssemblyClient`] and then attached to every
/// subsequent [`query_policy`] request so the gateway's
/// `validate_credential_token` does not deny a registered agent.
///
/// Delegates to [`AssemblyClient::register`], an async tonic call, so this napi
/// function is itself `async` and awaits it without blocking the Node event
/// loop. Returns the assigned policy id reported by the gateway. A failed
/// registration — gateway unreachable, identity rejected — surfaces as a typed
/// error so the caller can decide whether to proceed unregistered.
#[napi]
pub async fn register(handle: &ClientHandle, options: RegisterOptions) -> Result<String> {
  let config = AssemblyConfig {
    agent_id: options.agent_id,
    socket_path: None,
    gateway_endpoint: options.gateway_endpoint,
    team_id: options.team_id,
    parent_agent_id: options.parent_agent_id,
    // The version is signed at IPC-handshake time (`connect`), not on the
    // gateway register, so it is not needed for this config.
    sdk_version: None,
  };

  handle
    .inner
    .register(&config, options.name, options.framework)
    .await
    .map_err(|err| typed_error(ERR_REGISTER, &err.to_string()))
}

/// Ship a captured event to the runtime.
///
/// The JS event object is translated to the shared client's
/// `(event_type, details)` shape and forwarded via
/// [`AssemblyClient::report_event`]. Advisory preflight (inside the shared
/// client) may redact locally; the runtime re-scans the event authoritatively
/// regardless.
#[napi]
pub fn send_event(handle: &ClientHandle, event: Value) -> Result<()> {
  let (event_type, details) = translate_event(event);
  handle
    .inner
    .report_event(event_type, details)
    .map_err(|err| typed_error(ERR_SEND_EVENT, &err.to_string()))
}

/// A policy verdict returned to JS.
///
/// `decision` is one of `"allow"`, `"deny"`, `"pending"`, `"redact"`; `reason`
/// is the human-readable explanation from the policy engine (or the fail-open
/// note when the runtime did not answer).
#[napi(object)]
pub struct PolicyDecision {
  pub decision: String,
  pub reason: String,
}

/// Query the runtime for a policy decision on an action.
///
/// The JS query object is translated into a `CheckActionRequest` (agent id,
/// action type, and — for tool calls — tool name / source / args) and handed
/// to [`AssemblyClient::query_policy`], which blocks its calling thread for up
/// to 5s waiting on the runtime's `CheckActionResponse`. That blocking call is
/// run on a `spawn_blocking` task — exactly like [`disconnect`] — so the napi
/// async runtime stays free and the **Node event loop is never blocked** while
/// a slow runtime is answering.
///
/// **Fail-open:** the SDK is advisory, not a security boundary. When the
/// runtime does not return a decision — it is too slow or the connection
/// closed ([`SdkClientError::QueryFailed`]), or it was never reachable so the
/// IPC channel is closed / the session is shut down — this returns a non-deny
/// `"allow"` so a missing or degraded runtime never blocks the agent (the
/// proxy / eBPF layers remain authoritative). Only a genuine local fault
/// (a poisoned lock) surfaces as a typed error.
#[napi]
pub async fn query_policy(handle: &ClientHandle, query: Value) -> Result<PolicyDecision> {
  let request = translate_query(query);
  let client = Arc::clone(&handle.inner);

  let outcome = tokio::task::spawn_blocking(move || client.query_policy(request))
    .await
    .map_err(|err| typed_error(ERR_QUERY_POLICY, &err.to_string()))?;

  match outcome {
    Ok(response) => Ok(PolicyDecision {
      decision: decision_to_str(response.decision).to_string(),
      reason: response.reason,
    }),
    // Fail-open: a slow, unreachable, or shut-down runtime must never block the
    // agent. All three mean "no authoritative decision came back".
    Err(SdkClientError::QueryFailed)
    | Err(SdkClientError::ChannelClosed)
    | Err(SdkClientError::Shutdown) => Ok(PolicyDecision {
      decision: decision_to_str(Decision::Allow as i32).to_string(),
      reason: FAIL_OPEN_REASON.to_string(),
    }),
    Err(err) => Err(typed_error(ERR_QUERY_POLICY, &err.to_string())),
  }
}

/// Shut down the session and join the background IPC thread.
///
/// Idempotent — delegates to [`AssemblyClient::shutdown`], which blocks on the
/// background-thread join, so it runs on a blocking task to keep the napi async
/// runtime free.
#[napi]
pub async fn disconnect(handle: &ClientHandle) -> Result<()> {
  let client = Arc::clone(&handle.inner);
  tokio::task::spawn_blocking(move || client.shutdown())
    .await
    .map_err(|err| typed_error(ERR_DISCONNECT, &err.to_string()))?
    .map_err(|err| typed_error(ERR_DISCONNECT, &err.to_string()))
}

/// Translate a JS event object into the shared client's `(event_type, details)`
/// pair.
///
/// `event_type` is read from the object's `event_type` field (falling back to
/// `"event"`); the whole object is serialized as `details` so no captured data
/// is dropped before the runtime re-scans it.
fn translate_event(event: Value) -> (String, String) {
  let event_type = event
    .get("event_type")
    .and_then(Value::as_str)
    .unwrap_or("event")
    .to_string();
  let details = serde_json::to_string(&event).unwrap_or_default();
  (event_type, details)
}

/// Translate a JS policy-query object into a [`CheckActionRequest`].
///
/// Reads `agent_id`, `action_type`, and (for tool calls) `tool_name`,
/// `tool_source`, and `args` from the object. `args` is serialized to JSON
/// bytes for the policy engine to inspect; absent fields fall back to empty so
/// the runtime — which re-derives context authoritatively — always receives a
/// well-formed request. Wrapper-level field shaping (createClient) is Wave 3.
fn translate_query(query: Value) -> CheckActionRequest {
  let agent_id = query
    .get("agent_id")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let action_type_str = query
    .get("action_type")
    .and_then(Value::as_str)
    .unwrap_or("tool_call");

  let tool_name = query
    .get("tool_name")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let tool_source = query
    .get("tool_source")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let args_json = query
    .get("args")
    .map(|args| serde_json::to_vec(args).unwrap_or_default())
    .unwrap_or_default();

  let context = ActionContext {
    action: Some(action_context::Action::ToolCall(ToolCallContext {
      tool_name,
      tool_source,
      args_json,
      target_url: String::new(),
    })),
  };

  CheckActionRequest {
    agent_id: Some(AgentId {
      org_id: String::new(),
      team_id: String::new(),
      agent_id,
    }),
    action_type: action_type_from_str(action_type_str),
    context: Some(context),
    ..Default::default()
  }
}

/// Map a JS action-type string onto the proto [`ActionType`] discriminant.
fn action_type_from_str(value: &str) -> i32 {
  match value {
    "llm_call" => ActionType::LlmCall as i32,
    "tool_call" => ActionType::ToolCall as i32,
    "file_op" | "file_operation" => ActionType::FileOperation as i32,
    "network_call" => ActionType::NetworkCall as i32,
    "process_exec" => ActionType::ProcessExec as i32,
    "agent_spawn" => ActionType::AgentSpawn as i32,
    "tool_result" => ActionType::ToolResult as i32,
    _ => ActionType::ActionUnspecified as i32,
  }
}

/// Map a proto [`Decision`] discriminant onto its JS string.
fn decision_to_str(value: i32) -> &'static str {
  match Decision::try_from(value).unwrap_or(Decision::Unspecified) {
    Decision::Allow => "allow",
    Decision::Deny => "deny",
    Decision::Pending => "pending",
    Decision::Redact => "redact",
    Decision::Unspecified => "",
  }
}

fn typed_error(code: &str, message: &str) -> Error {
  Error::from_reason(format!("{code}:{message}"))
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;
  use std::time::Duration;

  use aa_proto::assembly::common::v1::Decision;
  use aa_proto::assembly::policy::v1::CheckActionResponse;
  use aa_sdk_client::codec;
  use aa_sdk_client::ipc::spawn_ipc_thread;
  use prost::Message;
  use serde_json::json;
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  use tokio::net::UnixListener;

  use super::*;

  /// The agent id the mock-server tests handshake as.
  const TEST_AGENT_ID: &str = "agent-1";

  /// A distinctive language-package version forwarded into `spawn_ipc_thread`, so
  /// the deny test asserts the FFI-passed version (not the crate version) reaches
  /// the signed handshake proof (AAASM-3683).
  const TEST_SDK_VERSION: &str = "npm-4.5.6";

  /// Server side of the AAASM-3587 session handshake the client now performs
  /// before any heartbeat: send a nonce challenge, read the signed proof, verify
  /// it over `nonce || sdk_version` (AAASM-3666), and return the signed version
  /// so callers can assert the FFI-forwarded version reached the handshake
  /// (AAASM-3683).
  async fn server_handshake<S>(stream: &mut S, agent_id: &str) -> String
  where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
  {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use sha2::{Digest, Sha256};

    // Value-returning CSPRNG so no constant literal flows into the signed nonce
    // (CodeQL hard-coded-crypto).
    let nonce = rand::random::<[u8; 32]>().to_vec();
    let challenge = aa_proto::assembly::ipc::v1::HandshakeChallenge { nonce: nonce.clone() };
    let payload = challenge.encode_to_vec();
    stream.write_u8(codec::TAG_HANDSHAKE_CHALLENGE).await.unwrap();
    assert!(payload.len() < 128);
    stream.write_u8(payload.len() as u8).await.unwrap();
    stream.write_all(&payload).await.unwrap();
    stream.flush().await.unwrap();

    assert_eq!(stream.read_u8().await.unwrap(), codec::TAG_HANDSHAKE_PROOF);
    let mut len: u64 = 0;
    let mut shift = 0u32;
    loop {
      let byte = stream.read_u8().await.unwrap();
      len |= ((byte & 0x7F) as u64) << shift;
      if byte & 0x80 == 0 {
        break;
      }
      shift += 7;
    }
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).await.unwrap();
    let proof = aa_proto::assembly::ipc::v1::HandshakeProof::decode(buf.as_ref()).unwrap();

    let seed: [u8; 32] = Sha256::digest(agent_id.as_bytes()).into();
    let vk = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key();
    assert_eq!(proof.public_key, hex::encode(vk.to_bytes()));
    let mut signed_payload = nonce.clone();
    signed_payload.extend_from_slice(proof.sdk_version.as_bytes());
    let sig: [u8; 64] = proof.signature.as_slice().try_into().unwrap();
    let vk2 = VerifyingKey::from_bytes(&vk.to_bytes()).unwrap();
    vk2
      .verify(&signed_payload, &Signature::from_bytes(&sig))
      .expect("client handshake proof must verify");

    proof.sdk_version
  }

  /// A `queryPolicy` against a runtime that answers `PolicyQuery` with a Deny
  /// `CheckActionResponse` returns `"deny"` to the JS caller. Mirrors the
  /// shared client's `query_policy_returns_runtime_decision` test, but drives
  /// the napi shim's `query_policy` end-to-end (translation + decision mapping).
  #[tokio::test]
  async fn query_policy_maps_runtime_deny() {
    let socket_path = format!("/tmp/aa-ffi-node-query-{}.sock", std::process::id());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();

    // Mock runtime: read the heartbeat + the PolicyQuery, then reply with a
    // Deny CheckActionResponse. Bodies here are < 128 bytes, so the
    // length-delimiter varint is a single byte.
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.unwrap();
      // AAASM-3587/3683: the client completes the signed handshake first; assert
      // the FFI-forwarded version reaches the proof.
      let signed_version = server_handshake(&mut stream, TEST_AGENT_ID).await;
      assert_eq!(signed_version, TEST_SDK_VERSION);
      assert_eq!(stream.read_u8().await.unwrap(), codec::TAG_HEARTBEAT);
      assert_eq!(stream.read_u8().await.unwrap(), codec::TAG_POLICY_QUERY);
      let len = stream.read_u8().await.unwrap() as usize;
      if len > 0 {
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).await.unwrap();
      }

      let resp = CheckActionResponse {
        decision: Decision::Deny as i32,
        reason: "blocked by policy".to_string(),
        ..Default::default()
      };
      let mut buf = Vec::new();
      resp.encode(&mut buf).unwrap();
      assert!(buf.len() < 128, "test assumes a single-byte length varint");
      stream.write_u8(codec::TAG_POLICY_RESPONSE).await.unwrap();
      stream.write_u8(buf.len() as u8).await.unwrap();
      stream.write_all(&buf).await.unwrap();
      stream.flush().await.unwrap();
      // Keep the connection open so the client can read the reply.
      tokio::time::sleep(Duration::from_millis(200)).await;
    });

    let ipc = spawn_ipc_thread(
      PathBuf::from(&socket_path),
      TEST_AGENT_ID.to_string(),
      TEST_SDK_VERSION.to_string(),
    )
    .unwrap();
    let handle = ClientHandle {
      inner: Arc::new(AssemblyClient::new(ipc, Vec::new())),
    };

    // query_policy is async (it offloads the blocking wait to spawn_blocking),
    // so await it directly without blocking the test's runtime.
    let result = query_policy(
      &handle,
      json!({
        "agent_id": "agent-1",
        "action_type": "tool_call",
        "tool_name": "run_python",
        "tool_source": "langchain",
        "args": { "code": "print(1)" },
      }),
    )
    .await;

    server.abort();
    let _ = std::fs::remove_file(&socket_path);

    let decision = result.expect("query_policy should return a verdict");
    assert_eq!(decision.decision, "deny");
    assert_eq!(decision.reason, "blocked by policy");
  }

  /// With no runtime listening, `query_policy` blocks until the 5s timeout,
  /// gets `SdkClientError::QueryFailed`, and **fails open**: it returns a
  /// non-deny `"allow"` so an unreachable runtime never blocks the agent.
  #[tokio::test]
  async fn query_policy_fails_open_when_no_runtime() {
    // A path nothing is listening on — spawn_ipc_thread starts the background
    // thread regardless; the query then times out with QueryFailed.
    let socket_path = format!("/tmp/aa-ffi-node-noserver-{}.sock", std::process::id());
    let _ = std::fs::remove_file(&socket_path);

    let ipc = spawn_ipc_thread(
      PathBuf::from(&socket_path),
      TEST_AGENT_ID.to_string(),
      TEST_SDK_VERSION.to_string(),
    )
    .unwrap();
    let handle = ClientHandle {
      inner: Arc::new(AssemblyClient::new(ipc, Vec::new())),
    };

    let result =
      query_policy(&handle, json!({ "agent_id": "agent-1", "tool_name": "run_python" })).await;

    let decision = result.expect("fail-open must surface as Ok, never an error");
    assert_eq!(
      decision.decision, "allow",
      "an unreachable runtime must fail open to allow"
    );
    assert_eq!(decision.reason, FAIL_OPEN_REASON);
  }
}
