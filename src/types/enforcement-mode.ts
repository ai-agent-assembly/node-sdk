/**
 * Per-agent governance posture sent to the gateway at registration.
 *
 * Mirrors `aa_core::EnforcementMode` on the wire; the snake_case tokens
 * are what the gateway's REST endpoint expects and what its REST → gRPC
 * bridge maps onto `RegisterRequest.enforcement_mode` (proto enum).
 *
 * - `"enforce"` — default; deny blocks the action, redact strips secrets.
 * - `"observe"` — dry-run; the gateway records what *would* have happened
 *   but lets every action through. Surfaced by `aa audit list --dry-run-only`.
 * - `"disabled"` — policy evaluation skipped entirely. Hermetic test only.
 */
export type EnforcementMode = "enforce" | "observe" | "disabled";

/**
 * Runtime-checkable list of valid {@link EnforcementMode} values, used by
 * `initAssembly` to reject unknown strings from callers who bypass the
 * TypeScript type system (plain JS, JSON config, dynamic input).
 */
export const ENFORCEMENT_MODES: readonly EnforcementMode[] = ["enforce", "observe", "disabled"] as const;
