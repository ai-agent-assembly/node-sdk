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

use aa_sdk_client::ipc::spawn_ipc_thread;
use aa_sdk_client::{AssemblyClient, AssemblyConfig};
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use serde_json::Value;

const ERR_CONNECT: &str = "AA_ERR_CONNECT";
const ERR_SEND_EVENT: &str = "AA_ERR_SEND_EVENT";
const ERR_DISCONNECT: &str = "AA_ERR_DISCONNECT";

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

fn typed_error(code: &str, message: &str) -> Error {
  Error::from_reason(format!("{code}:{message}"))
}
