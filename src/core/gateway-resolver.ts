/**
 * Resolve the gateway URL and API key for ``initAssembly``.
 *
 * Implements the zero-config developer-experience contract from Epic 17 (S-G):
 * ``initAssembly({})`` with no fields and no environment variables should
 * discover a local gateway at ``http://localhost:7391`` — probing it, and
 * auto-starting ``aasm start --mode local --foreground`` when not running.
 *
 * Resolution precedence (highest first):
 *
 *   1. Explicit field on the AssemblyConfig
 *   2. Environment variable (AAASM_GATEWAY_URL / AAASM_API_KEY)
 *   3. Config file (~/.aasm/config.yaml, optional js-yaml soft dep)
 *   4. Local default: probe http://localhost:7391, auto-start if absent
 */

export const DEFAULT_GATEWAY_URL = "http://localhost:7391";
export const DEFAULT_HEALTHZ_PATH = "/healthz";
export const DEFAULT_PROBE_TIMEOUT_MS = 500;
export const DEFAULT_AUTO_START_TIMEOUT_MS = 5000;
export const DEFAULT_CONFIG_FILE_PATH = "~/.aasm/config.yaml";

export const ENV_GATEWAY_URL = "AAASM_GATEWAY_URL";
export const ENV_API_KEY = "AAASM_API_KEY";

export const AASM_AUTO_START_ARGV = ["start", "--mode", "local", "--foreground"] as const;
