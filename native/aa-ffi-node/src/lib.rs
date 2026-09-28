//! Thin napi-rs shim over the shared [`aa_sdk_client`] runtime client.
//!
//! All transport, IPC wire codec, [`AssemblyClient`] lifecycle, and advisory
//! credential preflight live in `aa-sdk-client`; every piece of this binding's
//! own logic — the typed error-code vocabulary, the JS↔proto translation, and
//! the `query_policy` fail-open contract — lives in [`aa_ffi_node_core`]. This
//! crate only translates between the Node/napi world and those two, so the
//! runtime-client logic cannot drift between the language SDKs.
//!
//! # Why the logic is in a sibling crate (AAASM-6182)
//!
//! This crate is a `cdylib`: the `napi_*` C symbols it references are supplied
//! by the Node host process when the addon is loaded. A `cargo test` harness is
//! a standalone executable with no Node host, so those symbols are undefined at
//! link time and this crate's `lib test` target cannot be built at all — which
//! left three tests covering security-relevant behaviour unrunnable on every
//! machine. `aa-ffi-node-core` has no napi dependency and a plain rlib crate
//! type, so `cargo test -p aa-ffi-node-core` links and runs anywhere, including
//! CI. Every napi entry point below is a delegation, so those tests cover the
//! shipped code path rather than a copy of it.
//!
//! The SDK is **not** a security boundary. The mandatory runtime chokepoint
//! (`aa-runtime`, AAASM-2568) re-scans, re-redacts, and normalizes every event
//! authoritatively, so this shim holds **no** authoritative scanning, redaction,
//! or policy-decision logic — it captures events and ships them.

use std::sync::Arc;

use aa_ffi_node_core as core_logic;
use aa_ffi_node_core::TypedError;
use aa_sdk_client::ipc::spawn_ipc_thread;
use aa_sdk_client::{AssemblyClient, AssemblyConfig};
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use serde_json::Value;

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
    return Err(typed_error(core_logic::ERR_CONNECT, "socketPath cannot be empty"));
  }

  let config = AssemblyConfig {
    agent_id: agent_id.unwrap_or_default(),
    socket_path: Some(socket_path),
    gateway_endpoint: None,
    team_id: None,
    parent_agent_id: None,
    sdk_version,
    identity_dir: None,
  };
  let resolved = config.resolve_socket_path();

  let ipc = spawn_ipc_thread(resolved, config.agent_id.clone(), config.resolved_sdk_version())
    .map_err(|err| typed_error(core_logic::ERR_CONNECT, &err.to_string()))?;
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
/// error (code mapping in [`core_logic::register_error_code`]) so the caller can
/// decide whether to proceed unregistered.
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
    identity_dir: None,
  };

  handle
    .inner
    .register(&config, options.name, options.framework)
    .await
    .map_err(|err| typed_error(core_logic::register_error_code(&err), &err.to_string()))
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
  let (event_type, details) = core_logic::translate_event(event);
  handle
    .inner
    .report_event(event_type, details)
    .map_err(|err| typed_error(core_logic::ERR_SEND_EVENT, &err.to_string()))
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
/// Delegates to [`core_logic::query_policy`], which owns the translation, the
/// `spawn_blocking` offload that keeps the Node event loop free while a slow
/// runtime answers, and the **fail-open** contract: an unreachable, slow, or
/// shut-down runtime yields a non-deny `"allow"` rather than an error, because
/// the SDK is advisory and the proxy / eBPF layers remain authoritative. Only a
/// genuine local fault (a poisoned lock) surfaces as a typed error.
///
/// This function is exactly that delegation plus the napi type conversion; the
/// behaviour is covered by `aa-ffi-node-core`'s unit tests (AAASM-6182).
#[napi]
pub async fn query_policy(handle: &ClientHandle, query: Value) -> Result<PolicyDecision> {
  let outcome = core_logic::query_policy(Arc::clone(&handle.inner), query)
    .await
    .map_err(to_napi_error)?;

  Ok(PolicyDecision {
    decision: outcome.decision,
    reason: outcome.reason,
  })
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
    .map_err(|err| typed_error(core_logic::ERR_DISCONNECT, &err.to_string()))?
    .map_err(|err| typed_error(core_logic::ERR_DISCONNECT, &err.to_string()))
}

/// Render a host-independent [`TypedError`] as the single reason string napi
/// carries. The `CODE:message` shape the JS layer parses is defined by
/// `TypedError`'s `Display` impl and asserted by
/// `typed_error_renders_code_colon_message` in `aa-ffi-node-core`.
fn to_napi_error(err: TypedError) -> Error {
  Error::from_reason(err.to_string())
}

fn typed_error(code: &'static str, message: &str) -> Error {
  to_napi_error(TypedError::new(code, message))
}
