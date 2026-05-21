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
import { createConnection } from "node:net";
import { arch, homedir, platform } from "node:os";
import { delimiter as PATH_DELIM, dirname, join, resolve } from "node:path";
import { cwd, env } from "node:process";
import { fileURLToPath } from "node:url";

export const BINARY_NAME = "aasm";
export const DEFAULT_PORT = 7878;
export const DEFAULT_RUNTIME_HOST = "127.0.0.1";

export const USER_LOCAL_BIN: string = join(homedir(), ".local", "bin");
export const DOCKER_BASE_BIN = "/usr/local/bin";
export const RUNTIME_LOG_FILENAME = ".aasm-runtime.log";

/** npm sub-package name for the bundled platform binary (esbuild pattern). */
export const RUNTIME_SUBPACKAGE: string = `runtime-${platform()}-${arch()}`;

export const INSTALL_HINT: string = [
  "agent-assembly runtime not found.",
  "  Install with: pnpm add agent-assembly",
  "  Or manually:  brew install agent-assembly/tap/aasm",
  "               curl -fsSL https://get.agent-assembly.io | sh",
].join("\n");

/**
 * Path to the platform-specific `aasm` binary bundled as an optional npm
 * dependency. Resolved relative to this module so it works both in `src/`
 * (during tests) and `dist/esm/` (after build).
 */
function bundledRuntimeBinaryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/runtime.ts → ../node_modules/...
  // dist/esm/runtime.js → ../../node_modules/...
  const candidates = [
    resolve(here, "..", "node_modules", "@agent-assembly", RUNTIME_SUBPACKAGE, "bin", BINARY_NAME),
    resolve(here, "..", "..", "node_modules", "@agent-assembly", RUNTIME_SUBPACKAGE, "bin", BINARY_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
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
  if (existsSync(bundled)) return bundled;
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
 * `agentId` is accepted to keep the ticket-specified signature stable;
 * actual register-and-connect is performed by the existing gateway-aware
 * `@agent-assembly/sdk` `initAssembly` once the sidecar is reachable.
 *
 * Throws `Error` with {@link INSTALL_HINT} when no binary is found.
 */
export async function initAssembly(
  agentId?: string,
  port: number = DEFAULT_PORT,
): Promise<void> {
  void agentId; // not consumed at the lifecycle layer; see jsdoc
  if (await isRunning(port)) return;
  const binary = findAasmBinary();
  if (binary === null) {
    throw new Error(INSTALL_HINT);
  }
  startRuntime(binary, port);
}
