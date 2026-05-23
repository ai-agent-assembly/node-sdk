/**
 * Thrown when the SDK cannot resolve the gateway configuration —
 * e.g. the local gateway is absent and ``aasm`` is not on ``PATH``.
 *
 * Mirrors ``agent_assembly.exceptions.ConfigurationError`` in the
 * Python SDK so the cross-SDK error contract stays aligned per Epic 17 S-G.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
