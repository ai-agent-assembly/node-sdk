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
