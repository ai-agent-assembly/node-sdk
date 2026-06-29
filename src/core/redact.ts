/**
 * Secret-redaction helpers for diagnostic / log output (AAASM-3645).
 *
 * The resolved `apiKey` and the proto `credentialToken` must never reach
 * `console.*` or an accidental `JSON.stringify` dump. These helpers give the
 * SDK a single, audited way to render config/diagnostics for logging with the
 * credential fields stripped.
 *
 * NOTE: the generated `CheckActionRequest.toJSON()` (src/proto/generated) is
 * wire-only — it serializes `credentialToken` for transport and must never be
 * passed to a logger. Use {@link redactSecrets} on any object you intend to log.
 */

/**
 * Object keys (lower-cased) whose values are credentials and must never be
 * logged. Matching is case-insensitive, so list the lower-case form only —
 * `apiKey`, `apikey`, `API_KEY` all match `"apikey"`.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "apikey",
  "api_key",
  "credentialtoken",
  "credential_token",
  "authorization",
  "token",
  // AAASM-3896: defence-in-depth for future callers that log arbitrary config
  // or HTTP header maps. These key names commonly carry credentials even though
  // the SDK itself does not emit them today, so redact them pre-emptively.
  "password",
  "secret",
  "x-api-key",
  "cookie",
  "set-cookie"
]);

/** Placeholder substituted for any redacted credential value. */
export const REDACTED = "<redacted>";

/**
 * Return a deep copy of `value` with every credential-bearing field replaced by
 * {@link REDACTED}, safe to pass to `console.*` / `JSON.stringify`. Matching is
 * case-insensitive on the key name. Non-object inputs are returned unchanged.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redactSecrets(val);
    }
    return out;
  }
  return value;
}

/**
 * Render an unknown error for a log message with any `Bearer <token>` / API-key
 * substring scrubbed. Defends the registration-failure warning path: a wrapped
 * transport error could in principle carry an auth header in its message, so we
 * strip the bearer credential before it reaches `console.*` (AAASM-3645).
 */
export function redactErrorMessage(error: unknown): string {
  const raw = String(error);
  // Replace the credential that follows a `Bearer ` / `Authorization:` marker.
  return raw
    .replace(/(Bearer\s+)[\w.\-+/=]+/gi, `$1${REDACTED}`)
    .replace(/(Authorization\s*[:=]\s*)\S+/gi, `$1${REDACTED}`);
}
