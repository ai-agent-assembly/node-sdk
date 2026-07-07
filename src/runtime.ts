/**
 * Runtime auto-detection and lifecycle management for the `aasm` sidecar
 * (F115 / AAASM-1205).
 *
 * The `initAssembly()` exported here is intentionally NOT re-exported from
 * `@agent-assembly/sdk` at the top level: the existing gateway-based
 * `initAssembly(config)` keeps its meaning. Opt in to the runtime-managed
 * flow with `import { initAssembly } from "@agent-assembly/sdk/runtime"`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { arch, homedir, platform } from "node:os";
import { delimiter as PATH_DELIM, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { cwd, env } from "node:process";

export const BINARY_NAME = "aasm";
export const DEFAULT_PORT = 7878;
export const DEFAULT_RUNTIME_HOST = "127.0.0.1";

/**
 * Opt-in gate for spawning the `aasm` sidecar. Auto-start runs a binary
 * discovered from `$PATH` / the filesystem, so it is a privileged side effect
 * that must be explicitly enabled rather than triggered silently by every
 * `initAssembly()` call. Set to `1`/`true`/`yes` to permit auto-start.
 */
export const ENV_AUTO_START = "AA_AUTO_START";

export const USER_LOCAL_BIN: string = join(homedir(), ".local", "bin");
export const DOCKER_BASE_BIN = "/usr/local/bin";
export const RUNTIME_LOG_FILENAME = ".aasm-runtime.log";

/** npm sub-package name for the bundled platform binary (esbuild pattern). */
export const RUNTIME_SUBPACKAGE: string = `runtime-${platform()}-${arch()}`;

export const INSTALL_HINT: string = [
  "agent-assembly runtime not found.",
  "  Install with: pnpm add @agent-assembly/sdk",
  "  Or manually:  brew install ai-agent-assembly/tap/aasm",
  "               curl -fsSL https://agent-assembly.com/install.sh | sh",
].join("\n");

/**
 * Path to the platform-specific `aasm` binary bundled as an optional npm
 * dependency, or `null` when the consumer hasn't installed that platform's
 * `@agent-assembly/runtime-{platform}-{arch}` sub-package.
 *
 * Uses `createRequire(<cwd>/package.json)` — the same pattern used by
 * `src/native/client.ts` and the framework-detection modules — so this
 * module compiles cleanly under both the ESM and CJS build targets
 * (`import.meta.url` is ESM-only and breaks `tsconfig.cjs.json`).
 */
function bundledRuntimeBinaryPath(): string | null {
  try {
    const requireFromCwd = createRequire(`${cwd()}/package.json`);
    const pkgJson = requireFromCwd.resolve(`@agent-assembly/${RUNTIME_SUBPACKAGE}/package.json`);
    return join(dirname(pkgJson), "bin", BINARY_NAME);
  } catch {
    return null;
  }
}

/**
 * Locate the `aasm` binary across the 4 supported install paths.
 *
 * Search order: `$PATH` (Homebrew, cargo install) → `~/.local/bin/aasm`
 * (curl installer) → `node_modules/@agent-assembly/runtime-{platform}-{arch}/bin/aasm`
 * (npm optionalDependency) → `/usr/local/bin/aasm` (Docker base image).
 * Returns the first existing match, or `null` when none exist.
 */
export function findAasmBinary(): string | null {
  for (const dir of (env.PATH ?? "").split(PATH_DELIM)) {
    if (!dir) continue;
    const candidate = join(dir, BINARY_NAME);
    if (existsSync(candidate)) return candidate;
  }
  const userLocal = join(USER_LOCAL_BIN, BINARY_NAME);
  if (existsSync(userLocal)) return userLocal;
  const bundled = bundledRuntimeBinaryPath();
  if (bundled !== null && existsSync(bundled)) return bundled;
  const docker = join(DOCKER_BASE_BIN, BINARY_NAME);
  if (existsSync(docker)) return docker;
  return null;
}

/**
 * Resolve to `true` iff a local TCP listener accepts a connect on
 * `host:port` within 100 ms. Any socket error (refused, timeout,
 * unreachable) resolves to `false` and is treated as no sidecar.
 */
export function isRunning(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_RUNTIME_HOST,
): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = createConnection({ port, host, timeout: 100 });
    const settle = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveResult(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/** Truthy values that enable {@link ENV_AUTO_START}. */
function autoStartEnabled(): boolean {
  const raw = env[ENV_AUTO_START]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Install roots an auto-started `aasm` binary is permitted to live in, in
 * addition to the npm-bundled `node_modules/@agent-assembly/runtime-*` path
 * (which is trusted because it ships with the SDK install). This blocks a
 * `$PATH`-injected `./aasm` or a binary planted in an arbitrary writable
 * directory from being spawned.
 */
function allowedInstallDirs(): string[] {
  const home = homedir();
  return [
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    USER_LOCAL_BIN,
    join(home, ".cargo", "bin"),
    "/usr/local/cargo/bin",
    DOCKER_BASE_BIN,
  ];
}

/**
 * Throw `Error` unless `binaryPath` is safe to spawn: it must be absolute and
 * either resolve inside an allow-listed install dir (see
 * {@link allowedInstallDirs}) or be the npm-bundled runtime binary. This is the
 * integrity gate for the auto-start subprocess — without it the SDK would
 * execute whatever `aasm` happened to be first on `$PATH`.
 */
export function assertSafeBinaryPath(binaryPath: string): void {
  if (!isAbsolute(binaryPath)) {
    throw new Error(`Refusing to auto-start a non-absolute 'aasm' path: ${binaryPath}`);
  }
  const resolved = resolvePath(binaryPath);
  const bundled = bundledRuntimeBinaryPath();
  if (bundled !== null && resolvePath(bundled) === resolved) return;
  const comparable = platform() === "win32" ? resolved.toLowerCase() : resolved;
  const ok = allowedInstallDirs().some((dir) => {
    const resolvedDir = resolvePath(dir);
    const comparableDir = platform() === "win32" ? resolvedDir.toLowerCase() : resolvedDir;
    return comparable === comparableDir || comparable.startsWith(comparableDir + sep);
  });
  if (!ok) {
    throw new Error(
      `Refusing to auto-start 'aasm' from an untrusted location: ${resolved}. ` +
        `Install it under one of: ${allowedInstallDirs().join(", ")}.`
    );
  }
}

/**
 * Spawn `aasm serve --port <port>` as a detached background subprocess.
 *
 * Stdout/stderr are appended to `<logDir>/.aasm-runtime.log` (default
 * `process.cwd()`) so the sidecar outlives the parent. `detached: true`
 * + `child.unref()` releases the event loop so the Node process can
 * exit independently of the sidecar.
 */
export function startRuntime(
  binaryPath: string,
  port: number = DEFAULT_PORT,
  logDir: string = cwd(),
): ChildProcess {
  const logPath = join(logDir, RUNTIME_LOG_FILENAME);
  const fd = openSync(logPath, "a");
  const child = spawn(binaryPath, ["serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  return child;
}

/**
 * Ensure the local `aasm` sidecar is running, starting it if necessary.
 *
 * Lifecycle per F115 / AAASM-1205:
 *  1. Probe `host:port` via {@link isRunning}; return early if already up.
 *  2. Resolve the binary via {@link findAasmBinary}.
 *  3. Spawn the sidecar via {@link startRuntime}.
 *
 * `_agentId` is accepted to keep the ticket-specified signature stable but is
 * intentionally not consumed at this lifecycle layer; actual register-and-connect
 * is performed by the existing gateway-aware `@agent-assembly/sdk` `initAssembly`
 * once the sidecar is reachable.
 *
 * Auto-start is **opt-in**: when the sidecar is not already running, this
 * throws unless `AA_AUTO_START` is enabled. When it does spawn, the resolved
 * binary path is logged and integrity-checked via {@link assertSafeBinaryPath}.
 *
 * Throws `Error` with {@link INSTALL_HINT} when no binary is found, and a
 * descriptive `Error` when auto-start is not opted in or the resolved binary
 * fails the integrity check.
 */
export async function initAssembly(
  _agentId?: string,
  port: number = DEFAULT_PORT,
): Promise<void> {
  if (await isRunning(port)) return;
  if (!autoStartEnabled()) {
    throw new Error(
      `No aasm sidecar running on port ${port} and auto-start is disabled. ` +
        `Start it with 'aasm serve --port ${port}', or set ${ENV_AUTO_START}=1 ` +
        "to allow the SDK to auto-start it."
    );
  }
  const binary = findAasmBinary();
  if (binary === null) {
    throw new Error(INSTALL_HINT);
  }
  assertSafeBinaryPath(binary);
  console.info(`[agent-assembly] auto-starting aasm sidecar from ${binary}`);
  startRuntime(binary, port);
}
