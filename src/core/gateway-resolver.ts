import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { ConfigurationError, GatewayError } from "../errors/index.js";
import {
  INSTALL_HINT_NPM_SDK_GLOBAL_CLI,
  INSTALL_HINT_PNPM_GLOBAL_CLI
} from "../generated/install-hints.js";

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
 *   2. Environment variable — canonical ``AA_GATEWAY_URL`` / ``AA_API_KEY``,
 *      with the legacy ``AAASM_GATEWAY_URL`` / ``AAASM_API_KEY`` names accepted
 *      as deprecated aliases (a one-time warning is logged when a legacy name
 *      supplies the value)
 *   3. Config file (~/.aasm/config.yaml, optional js-yaml soft dep)
 *   4. Local default: probe http://localhost:7391; when absent, auto-start the
 *      local `aasm` gateway ONLY if `AA_AUTO_START` is opted in and the binary
 *      resolves to an allow-listed install dir — otherwise raise an error.
 */

export const DEFAULT_GATEWAY_URL = "http://localhost:7391";
export const DEFAULT_HEALTHZ_PATH = "/healthz";
export const DEFAULT_PROBE_TIMEOUT_MS = 500;
export const DEFAULT_AUTO_START_TIMEOUT_MS = 5000;
export const DEFAULT_CONFIG_FILE_PATH = "~/.aasm/config.yaml";

export const ENV_GATEWAY_URL = "AA_GATEWAY_URL";
export const ENV_API_KEY = "AA_API_KEY";

/**
 * Opt-in gate for auto-starting a local gateway. Auto-start spawns the `aasm`
 * binary resolved from `$PATH`, so it is gated behind an explicit opt-in rather
 * than running silently: a `$PATH` entry an attacker can write to would
 * otherwise be executed by any process that calls `initAssembly()`. Set to
 * `1`/`true`/`yes` to permit auto-start.
 */
export const ENV_AUTO_START = "AA_AUTO_START";

/** Truthy values that enable {@link ENV_AUTO_START}. */
function autoStartEnabled(): boolean {
  const raw = process.env[ENV_AUTO_START]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Directories an auto-started `aasm` binary is permitted to live in. The
 * resolved path must be absolute and sit inside one of these install roots,
 * which blocks a `$PATH`-injected `./aasm` (cwd) or a binary planted in an
 * arbitrary writable directory from being spawned. Mirrors the documented
 * install locations (Homebrew, system, user-local, cargo).
 */
function allowedInstallDirs(): string[] {
  const home = homedir();
  return [
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/usr/local/cargo/bin",
  ];
}

/**
 * Throw {@link ConfigurationError} unless `aasmPath` is an absolute path inside
 * an allow-listed install directory (see {@link allowedInstallDirs}). This is
 * the integrity gate for the auto-start subprocess — without it the SDK would
 * execute whatever `aasm` happened to be first on `$PATH`.
 */
export function assertAllowedAasmPath(aasmPath: string): void {
  if (!isAbsolute(aasmPath)) {
    throw new ConfigurationError(
      `Refusing to auto-start a non-absolute 'aasm' path: ${aasmPath}. ` +
        `Set ${ENV_GATEWAY_URL} to an already-running gateway instead.`
    );
  }
  const resolved = resolvePath(aasmPath);
  const ok = allowedInstallDirs().some((dir) => resolved.startsWith(dir + "/"));
  if (!ok) {
    throw new ConfigurationError(
      `Refusing to auto-start 'aasm' from an untrusted location: ${resolved}. ` +
        `Install it under one of: ${allowedInstallDirs().join(", ")}, ` +
        `or set ${ENV_GATEWAY_URL} to an already-running gateway.`
    );
  }
}

/**
 * Deprecated environment-variable names, kept as backwards-compatible aliases.
 *
 * When one of these supplies a value (and the canonical ``AA_*`` name is unset)
 * a one-time deprecation warning is emitted via ``readEnvWithDeprecation``.
 */
export const LEGACY_ENV_GATEWAY_URL = "AAASM_GATEWAY_URL";
export const LEGACY_ENV_API_KEY = "AAASM_API_KEY";

/**
 * Tracks which legacy env-var names have already produced a deprecation
 * warning so the message is logged at most once per name per process.
 */
const _warnedLegacyEnv = new Set<string>();

/**
 * Read an environment variable preferring the canonical ``AA_*`` name and
 * falling back to a deprecated ``AAASM_*`` alias.
 *
 * Returns ``undefined`` when neither name is set. When the value comes from
 * the legacy alias, a deprecation warning is logged exactly once per legacy
 * name (guarded by ``_warnedLegacyEnv``) directing the user to the canonical
 * name.
 */
function readEnvWithDeprecation(canonicalName: string, legacyName: string): string | undefined {
  const canonical = process.env[canonicalName];
  if (canonical) return canonical;

  const legacy = process.env[legacyName];
  if (legacy) {
    if (!_warnedLegacyEnv.has(legacyName)) {
      _warnedLegacyEnv.add(legacyName);
      console.warn(
        `[agent-assembly] ${legacyName} is deprecated and will be removed in a ` +
          `future release. Use ${canonicalName} instead.`
      );
    }
    return legacy;
  }

  return undefined;
}

export const AASM_AUTO_START_ARGV = ["start", "--mode", "local", "--foreground"] as const;

/**
 * Return true if a gateway responds with a 2xx status at ``{baseUrl}/healthz``.
 *
 * Uses the global ``fetch`` (Node 18+) with an AbortController-driven
 * timeout. Any network / timeout / parse error is swallowed and reported
 * as ``false`` — the resolver treats unreachable as "absent" rather than
 * fatal.
 */
export async function probeHealthz(
  baseUrl: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS
): Promise<boolean> {
  let trimmedBase = baseUrl;
  while (trimmedBase.endsWith("/")) {
    trimmedBase = trimmedBase.slice(0, -1);
  }
  const url = trimmedBase + DEFAULT_HEALTHZ_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll the gateway healthz endpoint until success or timeout.
 *
 * Resolves ``true`` as soon as ``probeHealthz`` succeeds, ``false`` if
 * the gateway has not become ready within ``timeoutMs``. The poll
 * interval is short (default 100ms) so the auto-start path feels
 * instant when the local CP comes up quickly.
 */
export async function waitForHealthz(
  baseUrl: string,
  timeoutMs: number = DEFAULT_AUTO_START_TIMEOUT_MS,
  pollIntervalMs: number = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealthz(baseUrl)) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return probeHealthz(baseUrl);
}

function expandHome(p: string): string {
  if (!p.startsWith("~")) {
    return p;
  }
  const prefixLength = p.startsWith("~/") ? 2 : 1;
  return resolvePath(homedir(), p.slice(prefixLength));
}

/**
 * Load ``~/.aasm/config.yaml`` if present.
 *
 * Returns an empty record when the file is missing, when ``js-yaml`` is
 * not installed (it is a soft dependency for SDK consumers), or when
 * the file's contents are not an object. This keeps the resolver chain
 * purely advisory at step 3 — never throws.
 */
export async function loadConfigFile(
  configPath: string = DEFAULT_CONFIG_FILE_PATH
): Promise<Record<string, unknown>> {
  // Indirect specifier defeats static module resolution so missing js-yaml
  // surfaces at runtime (caught below) rather than as a TS compile error.
  const yamlSpec = "js-yaml";
  let yamlMod: { load: (input: string) => unknown };
  try {
    yamlMod = (await import(yamlSpec)) as { load: (input: string) => unknown };
  } catch {
    return {};
  }

  const expanded = expandHome(configPath);
  if (!existsSync(expanded)) {
    return {};
  }

  try {
    const parsed = yamlMod.load(readFileSync(expanded, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function defaultFindAasmOnPath(): string | null {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `aasm${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function defaultSpawnAasm(aasmPath: string): void {
  const child = spawn(aasmPath, [...AASM_AUTO_START_ARGV], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Mutable seams used by ``autoStartGateway`` — exposed via ``__testing``
 * so tests can stub the PATH lookup and subprocess spawn without using
 * ESM module mocking. Production callers should treat this as private.
 */
const _seams = {
  findAasmOnPath: defaultFindAasmOnPath,
  spawnAasm: defaultSpawnAasm,
  probeHealthz: probeHealthz,
  loadConfigFile: loadConfigFile,
  autoStartGateway: autoStartGateway,
};

export const __testing = {
  _seams,
  resetLegacyEnvWarnings: (): void => {
    _warnedLegacyEnv.clear();
  },
};

/**
 * Spawn ``aasm start --mode local --foreground`` and wait until ``/healthz``
 * responds.
 *
 * Throws ``ConfigurationError`` when the ``aasm`` binary is missing from
 * PATH — the SDK cannot meaningfully auto-start without it. Throws
 * ``GatewayError`` when the spawned gateway does not become ready within
 * ``timeoutMs``. The subprocess is launched detached + stdio:"ignore" so
 * it survives the parent Node process — the docker-style daemon hand-off
 * described in Epic 17 S-G.
 */
export async function autoStartGateway(
  baseUrl: string = DEFAULT_GATEWAY_URL,
  timeoutMs: number = DEFAULT_AUTO_START_TIMEOUT_MS
): Promise<void> {
  const aasmPath = _seams.findAasmOnPath();
  if (aasmPath === null) {
    throw new ConfigurationError(
      `No gateway found at ${baseUrl} and 'aasm' is not on PATH. ` +
        `Install it with: ${INSTALL_HINT_NPM_SDK_GLOBAL_CLI} (or ${INSTALL_HINT_PNPM_GLOBAL_CLI})`
    );
  }

  // Integrity gate: only spawn an absolute path from an allow-listed install
  // dir, and surface the resolved path so the operator can see exactly which
  // binary the SDK is about to execute.
  assertAllowedAasmPath(aasmPath);
  console.info(`[agent-assembly] auto-starting gateway from ${aasmPath}`);

  _seams.spawnAasm(aasmPath);

  if (!(await waitForHealthz(baseUrl, timeoutMs))) {
    throw new GatewayError(
      `Auto-started gateway at ${baseUrl} did not become ready ` +
        `within ${(timeoutMs / 1000).toFixed(0)} seconds`
    );
  }
}

/**
 * Resolve the gateway URL using the 4-step precedence chain.
 *
 * Returns the resolved URL. May spawn a local ``aasm`` subprocess
 * (step 4 only). Propagates ``ConfigurationError`` / ``GatewayError``
 * from ``autoStartGateway`` when the local default is needed but
 * cannot be brought up.
 */
export async function resolveGatewayUrl(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const fromEnv = readEnvWithDeprecation(ENV_GATEWAY_URL, LEGACY_ENV_GATEWAY_URL);
  if (fromEnv) return fromEnv;

  const config = await _seams.loadConfigFile();
  const agent = config["agent"];
  if (agent !== null && typeof agent === "object") {
    const url = (agent as Record<string, unknown>)["gateway_url"];
    if (typeof url === "string" && url.length > 0) return url;
  }

  if (await _seams.probeHealthz(DEFAULT_GATEWAY_URL)) {
    return DEFAULT_GATEWAY_URL;
  }

  // Auto-start is opt-in: spawning the local `aasm` binary is a privileged
  // side effect, so a missing gateway is a hard error unless the operator has
  // explicitly enabled AA_AUTO_START.
  if (!autoStartEnabled()) {
    throw new ConfigurationError(
      `No gateway found at ${DEFAULT_GATEWAY_URL}. Start one with 'aasm start ` +
        `--mode local', set ${ENV_GATEWAY_URL} to a running gateway, or set ` +
        `${ENV_AUTO_START}=1 to allow the SDK to auto-start a local gateway.`
    );
  }

  await _seams.autoStartGateway(DEFAULT_GATEWAY_URL);
  return DEFAULT_GATEWAY_URL;
}

/**
 * Resolve the API key using the same 4-step precedence as the URL.
 *
 * Returns the resolved key (possibly empty for local mode, which
 * accepts unauthenticated agents). Never rejects — an empty API key
 * is the documented "local dev" default per Epic 17.
 */
export async function resolveApiKey(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const fromEnv = readEnvWithDeprecation(ENV_API_KEY, LEGACY_ENV_API_KEY);
  if (fromEnv) return fromEnv;

  const config = await _seams.loadConfigFile();
  const agent = config["agent"];
  if (agent !== null && typeof agent === "object") {
    const apiKey = (agent as Record<string, unknown>)["api_key"];
    if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
  }

  return "";
}

