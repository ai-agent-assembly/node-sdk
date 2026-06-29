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
  "set-cookie",
  // AAASM-3925: additional credential-bearing key names seen in the wild
  // (OAuth tokens, mTLS material, session handles, hyphenated header forms).
  "access_token",
  "refresh_token",
  "client_secret",
  "private_key",
  "credential",
  "passwd",
  "session",
  "api-key"
]);

/**
 * Suffix / substring patterns that catch *future* credential-key variants the
 * exact {@link SECRET_KEYS} set has not enumerated (AAASM-3925). Applied to the
 * lower-cased key name.
 *
 * `secret` and `token` are matched as **suffixes** (`endsWith`), not substrings,
 * on purpose: `client_secret` / `clientSecret` and `accessToken` / `csrf_token`
 * are caught while a benign key that merely *starts* with the word (e.g.
 * `secretSantaName`, `tokenCount`) is preserved. `password` is matched as a
 * substring because every key containing it is credential-bearing.
 */
function isSecretKey(rawKey: string): boolean {
  const key = rawKey.toLowerCase();
  if (SECRET_KEYS.has(key)) {
    return true;
  }
  return key.endsWith("token") || key.endsWith("secret") || key.includes("password");
}

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
      out[key] = isSecretKey(key) ? REDACTED : redactSecrets(val);
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
