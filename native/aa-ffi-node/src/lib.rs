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
#[napi]
pub async fn connect(socket_path: String) -> Result<ClientHandle> {
  if socket_path.trim().is_empty() {
    return Err(typed_error(ERR_CONNECT, "socketPath cannot be empty"));
  }

  let config = AssemblyConfig {
    agent_id: String::new(),
    socket_path: Some(socket_path),
  };
  let resolved = config.resolve_socket_path();

  let ipc =
    spawn_ipc_thread(resolved).map_err(|err| typed_error(ERR_CONNECT, &err.to_string()))?;
  let client = AssemblyClient::new(ipc, Vec::new());

  Ok(ClientHandle {
    inner: Arc::new(client),
  })
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

/// Synchronously query the runtime for a policy decision on an action.
///
/// The JS query object is translated into a `CheckActionRequest` (agent id,
/// action type, and — for tool calls — tool name / source / args) and handed
/// to [`AssemblyClient::query_policy`], which blocks the calling thread for up
/// to 5s waiting on the runtime's `CheckActionResponse`.
///
/// **Fail-open:** the SDK is advisory, not a security boundary. When the
/// runtime does not return a decision — it is too slow or the connection
/// closed ([`SdkClientError::QueryFailed`]), or it was never reachable so the
/// IPC channel is closed / the session is shut down — this returns a non-deny
/// `"allow"` so a missing or degraded runtime never blocks the agent (the
/// proxy / eBPF layers remain authoritative). Only a genuine local fault
/// (a poisoned lock) surfaces as a typed error.
#[napi]
pub fn query_policy(handle: &ClientHandle, query: Value) -> Result<PolicyDecision> {
  let request = translate_query(query);

  match handle.inner.query_policy(request) {
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

    let ipc = spawn_ipc_thread(PathBuf::from(&socket_path)).unwrap();
    let handle = ClientHandle {
      inner: Arc::new(AssemblyClient::new(ipc, Vec::new())),
    };

    // query_policy blocks the calling thread, so run it off the async runtime.
    let result = tokio::task::spawn_blocking(move || {
      query_policy(
        &handle,
        json!({
          "agent_id": "agent-1",
          "action_type": "tool_call",
          "tool_name": "run_python",
          "tool_source": "langchain",
          "args": { "code": "print(1)" },
        }),
      )
    })
    .await
    .unwrap();

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

    let ipc = spawn_ipc_thread(PathBuf::from(&socket_path)).unwrap();
    let handle = ClientHandle {
      inner: Arc::new(AssemblyClient::new(ipc, Vec::new())),
    };

    let result = tokio::task::spawn_blocking(move || {
      query_policy(&handle, json!({ "agent_id": "agent-1", "tool_name": "run_python" }))
    })
    .await
    .unwrap();

    let decision = result.expect("fail-open must surface as Ok, never an error");
    assert_eq!(
      decision.decision, "allow",
      "an unreachable runtime must fail open to allow"
    );
    assert_eq!(decision.reason, FAIL_OPEN_REASON);
  }
}
