/**
 * Runtime auto-detection and lifecycle management for the `aasm` sidecar
 * (F115 / AAASM-1205).
 *
 * The `initAssembly()` exported here is intentionally NOT re-exported from
 * `@agent-assembly/sdk` at the top level: the existing gateway-based
 * `initAssembly(config)` keeps its meaning. Opt in to the runtime-managed
 * flow with `import { initAssembly } from "@agent-assembly/sdk/runtime"`.
 */

import { arch, homedir, platform } from "node:os";
import { join } from "node:path";

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
