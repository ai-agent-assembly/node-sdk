/**
 * Thrown when the SDK has a gateway URL but cannot talk to it —
 * e.g. ``aasm`` was spawned but ``/healthz`` did not become ready
 * within the auto-start timeout window.
 *
 * Mirrors ``agent_assembly.exceptions.GatewayError`` in the Python SDK.
 */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}
