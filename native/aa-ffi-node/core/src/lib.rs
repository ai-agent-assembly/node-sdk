//! Host-independent core of the Agent Assembly Node binding.
//!
//! Everything the Node binding does that is **not** napi glue lives here: the
//! typed error-code vocabulary, the JS↔proto translation, and the `query_policy`
//! fail-open contract. The sibling [`aa-ffi-node`] crate is a thin napi shim
//! that converts these plain Rust types into napi ones and nothing more.
//!
//! # Why this crate exists (AAASM-6182)
//!
//! `aa-ffi-node` is a `cdylib`. The `napi_*` C symbols its `napi` dependency
//! references are supplied by the **Node host process** at addon load time, so
//! the loader resolves them when Node loads the `.node` file. A `cargo test`
//! harness is a standalone executable with no Node host, so those same symbols
//! are simply undefined at link time and the `lib test` target fails to link:
//!
//! ```text
//! error: linking with `cc` failed: exit status: 1
//!   = note: Undefined symbols for architecture arm64:
//!             "_napi_call_threadsafe_function", ...
//!             "_napi_delete_reference", ...
//!             "_napi_reference_unref", ...
//! error: could not compile `aa-ffi-node` (lib test)
//! ```
//!
//! Three tests pinning security-relevant behaviour — the runtime `Deny`
//! mapping and the no-runtime fail-open path — were therefore unrunnable on any
//! machine since the day they were written. This crate has no napi dependency
//! and a plain `rlib` crate type, so `cargo test -p aa-ffi-node-core` links and
//! runs on every platform, in CI, with no Node host and no linker flags.
//!
//! The coverage is not indirection: the functions below *are* the shipped code
//! path. `aa-ffi-node`'s napi entry points call straight into them.
//!
//! The SDK is **not** a security boundary. The mandatory runtime chokepoint
//! (`aa-runtime`, AAASM-2568) re-scans, re-redacts, and normalizes every event
//! authoritatively, so nothing here holds authoritative scanning, redaction, or
//! policy-decision logic.

use std::fmt;
use std::sync::Arc;

use aa_proto::assembly::common::v1::{ActionType, AgentId, Decision};
use aa_proto::assembly::policy::v1::{
  action_context, ActionContext, CheckActionRequest, ToolCallContext,
};
use aa_sdk_client::{AssemblyClient, SdkClientError};
use serde_json::Value;

pub const ERR_CONNECT: &str = "AA_ERR_CONNECT";
pub const ERR_REGISTER: &str = "AA_ERR_REGISTER";
// AAASM-6119: distinct from ERR_REGISTER so a caller can branch on the error
// code (not just parse the message) between "this agent has no identity to
// register with" (prompt for key provisioning) and any other registration
// failure (gateway unreachable / gateway rejected — arguably worth retrying).
pub const ERR_IDENTITY_UNAVAILABLE: &str = "AA_ERR_IDENTITY_UNAVAILABLE";
pub const ERR_SEND_EVENT: &str = "AA_ERR_SEND_EVENT";
pub const ERR_DISCONNECT: &str = "AA_ERR_DISCONNECT";
pub const ERR_QUERY_POLICY: &str = "AA_ERR_QUERY_POLICY";

/// Reason attached to a fail-open `allow` when the runtime does not answer.
///
/// The SDK is advisory, not a security boundary: an unreachable or slow
/// `aa-runtime` must never block the agent (the proxy / eBPF layers remain
/// authoritative), so a [`SdkClientError::QueryFailed`] is surfaced as an
/// `allow` rather than a hard error.
pub const FAIL_OPEN_REASON: &str = "aa-runtime unreachable or slow; failing open (advisory SDK)";

/// A `CODE:message` failure, host-independent.
///
/// The napi shim renders this with [`fmt::Display`] into the single reason
/// string napi's `Error::from_reason` takes, so the `CODE:message` shape the JS
/// layer parses is defined — and tested — here rather than at the FFI boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedError {
  pub code: &'static str,
  pub message: String,
}

impl TypedError {
  pub fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl fmt::Display for TypedError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}:{}", self.code, self.message)
  }
}

/// A policy verdict, host-independent.
///
/// `decision` is one of `"allow"`, `"deny"`, `"pending"`, `"redact"`; `reason`
/// is the human-readable explanation from the policy engine (or the fail-open
/// note when the runtime did not answer). The napi shim copies these two fields
/// verbatim into its `#[napi(object)] PolicyDecision`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyOutcome {
  pub decision: String,
  pub reason: String,
}

/// Map a [`SdkClientError`] from `AssemblyClient::register` onto its typed
/// error code. IdentityUnavailable gets its own code (AAASM-6119) — it's a
/// different failure class (refused before the gateway was ever contacted)
/// from every other registration outcome, which all still share ERR_REGISTER
/// unchanged.
pub fn register_error_code(err: &SdkClientError) -> &'static str {
  match err {
    SdkClientError::IdentityUnavailable(_) => ERR_IDENTITY_UNAVAILABLE,
    _ => ERR_REGISTER,
  }
}

/// Query the runtime for a policy decision on an action.
///
/// The JS query object is translated into a `CheckActionRequest` (agent id,
/// action type, and — for tool calls — tool name / source / args) and handed
/// to `AssemblyClient::query_policy`, which blocks its calling thread for up
/// to 5s waiting on the runtime's `CheckActionResponse`. That blocking call is
/// run on a `spawn_blocking` task so the napi async runtime stays free and the
/// **Node event loop is never blocked** while a slow runtime is answering.
///
/// **Fail-open:** the SDK is advisory, not a security boundary. When the
/// runtime does not return a decision — it is too slow or the connection
/// closed ([`SdkClientError::QueryFailed`]), or it was never reachable so the
/// IPC channel is closed / the session is shut down — this returns a non-deny
/// `"allow"` so a missing or degraded runtime never blocks the agent (the
/// proxy / eBPF layers remain authoritative). Only a genuine local fault
/// (a poisoned lock) surfaces as a typed error.
pub async fn query_policy(
  client: Arc<AssemblyClient>,
  query: Value,
) -> Result<PolicyOutcome, TypedError> {
  let request = translate_query(query);

  let outcome = tokio::task::spawn_blocking(move || client.query_policy(request))
    .await
    .map_err(|err| TypedError::new(ERR_QUERY_POLICY, err.to_string()))?;

  match outcome {
    Ok(response) => Ok(PolicyOutcome {
      decision: decision_to_str(response.decision).to_string(),
      reason: response.reason,
    }),
    // Fail-open: a slow, unreachable, or shut-down runtime must never block the
    // agent. All three mean "no authoritative decision came back".
    Err(SdkClientError::QueryFailed)
    | Err(SdkClientError::ChannelClosed)
    | Err(SdkClientError::Shutdown) => Ok(PolicyOutcome {
      decision: decision_to_str(Decision::Allow as i32).to_string(),
      reason: FAIL_OPEN_REASON.to_string(),
    }),
    Err(err) => Err(TypedError::new(ERR_QUERY_POLICY, err.to_string())),
  }
}

/// Translate a JS event object into the shared client's `(event_type, details)`
/// pair.
///
/// `event_type` is read from the object's `event_type` field (falling back to
/// `"event"`); the whole object is serialized as `details` so no captured data
/// is dropped before the runtime re-scans it.
pub fn translate_event(event: Value) -> (String, String) {
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
/// well-formed request.
pub fn translate_query(query: Value) -> CheckActionRequest {
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
pub fn action_type_from_str(value: &str) -> i32 {
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
pub fn decision_to_str(value: i32) -> &'static str {
  match Decision::try_from(value).unwrap_or(Decision::Unspecified) {
    Decision::Allow => "allow",
    Decision::Deny => "deny",
    Decision::Pending => "pending",
    Decision::Redact => "redact",
    Decision::Unspecified => "",
  }
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

  /// AAASM-6119: IdentityUnavailable must map to its own error code, distinct
  /// from every other registration outcome (which all keep sharing
  /// ERR_REGISTER unchanged) — the whole point of this change.
  #[test]
  fn register_error_code_distinguishes_identity_unavailable() {
    assert_eq!(
      register_error_code(&SdkClientError::IdentityUnavailable("no key".to_string())),
      ERR_IDENTITY_UNAVAILABLE
    );
    for other in [
      SdkClientError::GatewayUnreachable,
      SdkClientError::RegisterFailed("invalid did:key".to_string()),
      SdkClientError::Shutdown,
      SdkClientError::QueryFailed,
      SdkClientError::ChannelClosed,
      SdkClientError::LockPoisoned,
    ] {
      assert_eq!(
        register_error_code(&other),
        ERR_REGISTER,
        "{other:?} unexpectedly did not map to ERR_REGISTER"
      );
    }
  }

  /// AAASM-6182: the napi shim renders a [`TypedError`] into napi's single
  /// reason string via `Display`, so the `CODE:message` shape the JS layer
  /// parses to recover the error code is pinned here. Without this, moving the
  /// formatting off the FFI boundary would be untested.
  #[test]
  fn typed_error_renders_code_colon_message() {
    assert_eq!(
      TypedError::new(ERR_IDENTITY_UNAVAILABLE, "no signing key on disk").to_string(),
      "AA_ERR_IDENTITY_UNAVAILABLE:no signing key on disk"
    );
    // An empty message still keeps the separator, so a JS `split(':')` never
    // silently reads the code as the message.
    assert_eq!(
      TypedError::new(ERR_QUERY_POLICY, "").to_string(),
      "AA_ERR_QUERY_POLICY:"
    );
  }

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
  /// the binding's own `query_policy` end-to-end (translation + decision
  /// mapping) — the function the napi shim delegates straight to.
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
    let client = Arc::new(AssemblyClient::new(ipc, Vec::new()));

    // query_policy is async (it offloads the blocking wait to spawn_blocking),
    // so await it directly without blocking the test's runtime.
    let result = query_policy(
      client,
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
    let client = Arc::new(AssemblyClient::new(ipc, Vec::new()));

    let result =
      query_policy(client, json!({ "agent_id": "agent-1", "tool_name": "run_python" })).await;

    let decision = result.expect("fail-open must surface as Ok, never an error");
    assert_eq!(
      decision.decision, "allow",
      "an unreachable runtime must fail open to allow"
    );
    assert_eq!(decision.reason, FAIL_OPEN_REASON);
  }
}
