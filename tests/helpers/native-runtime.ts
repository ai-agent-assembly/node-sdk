import { createRequire } from "node:module";
import { arch, platform } from "node:os";

const requireFromHere = createRequire(import.meta.url);

/**
 * Name of the platform-specific bundled-runtime package that ships the native
 * `aasm` binary for the given OS/arch, e.g. `@agent-assembly/runtime-linux-x64`.
 *
 * Mirrors the `runtime-${platform}-${arch}` naming used by `src/runtime.ts` and
 * the `optionalDependencies` in package.json. On Windows this resolves to
 * `@agent-assembly/runtime-win32-x64`, which is not yet built/published
 * (AAASM-3544 / AAASM-3809).
 */
export function runtimePackageName(
  osPlatform: string = platform(),
  osArch: string = arch()
): string {
  return `@agent-assembly/runtime-${osPlatform}-${osArch}`;
}

/**
 * True when the bundled native runtime package for the current platform is
 * resolvable (installed).
 *
 * Returns `false` on platforms with no published runtime package — Windows
 * today, since `@agent-assembly/runtime-win32-x64` (the napi-rs Windows native
 * binding / bundled `aasm` runtime) is not yet built or published. Keyed on the
 * actual package availability rather than `process.platform`, so any suite that
 * guards on this re-enables itself automatically once the Windows runtime
 * package is published.
 */
export function nativeRuntimeAvailable(): boolean {
  try {
    requireFromHere.resolve(`${runtimePackageName()}/package.json`);
    return true;
  } catch {
    return false;
  }
}
