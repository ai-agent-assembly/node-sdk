import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Native-binding provisioning check run at install time.
 *
 * The napi-rs `.node` binaries ship *inside* `@agent-assembly/sdk` under
 * `native/aa-ffi-node/` (see package.json `files` → `native/aa-ffi-node/*.node`)
 * and are resolved at load time by `native/aa-ffi-node/index.cjs`. There is no
 * separately published per-platform `@agent-assembly/<platform>` binary package
 * to install from — the declared `@agent-assembly/runtime-*` optionalDependencies
 * ship the `aasm` CLI, not a `.node`. The earlier postinstall resolved phantom
 * `@agent-assembly/<platformKey>` names that were never published, so it always
 * threw, got caught, warned, and no-opped — masking a genuine missing-binary
 * regression until the loud failure at first native load (AAASM-4137).
 *
 * This script therefore *verifies* the bundled binding for the current platform
 * is present (mirroring `index.cjs` resolution) so a provisioning regression
 * fails at install time rather than only at first `initAssembly`.
 */

const SUPPORTED_PLATFORM_KEYS = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "win32-x64": "win32-x64-msvc"
};

const NATIVE_BINDING_DIR = "native/aa-ffi-node";

export function detectPlatformKey(platform = process.platform, arch = process.arch) {
  return SUPPORTED_PLATFORM_KEYS[`${platform}-${arch}`] ?? null;
}

/**
 * Locate the bundled native binding inside `native/aa-ffi-node/`, mirroring the
 * runtime loader in `native/aa-ffi-node/index.cjs`: prefer the exact
 * `index.node`, otherwise **this platform's** `index.<platformKey>.node`.
 * Returns the absolute path, or `null` when no matching binding is present.
 *
 * `platformKey` is the napi triple for the current platform (e.g.
 * `linux-x64-gnu`). Selecting by triple — not the first `index.*.node` a
 * directory scan happens to return — is what keeps a multi-platform bundle (all
 * three `index.<triple>.node` shipped together) from loading a wrong-arch
 * binary (AAASM-4467).
 */
export function findBundledNativeBinary(nativeDir, platformKey) {
  const directPath = path.join(nativeDir, "index.node");
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  if (!fs.existsSync(nativeDir)) {
    return null;
  }

  const triplePath = path.join(nativeDir, `index.${platformKey}.node`);
  return fs.existsSync(triplePath) ? triplePath : null;
}

export function selectBinaryForCurrentPlatform(options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    cwd = process.cwd(),
    nativeDir = path.resolve(cwd, NATIVE_BINDING_DIR),
    logger = console
  } = options;

  const platformKey = detectPlatformKey(platform, arch);

  if (!platformKey) {
    logger.warn(
      `[agent-assembly] Unsupported platform: ${platform}-${arch}; skipping native binding check.`
    );
    return null;
  }

  const binaryPath = findBundledNativeBinary(nativeDir, platformKey);

  if (!binaryPath) {
    throw new Error(
      `No bundled native binding (.node) found in ${NATIVE_BINDING_DIR} for ${platformKey}`
    );
  }

  logger.info(
    `[agent-assembly] Native binding present for ${platformKey}: ${path.basename(binaryPath)}`
  );

  return {
    platformKey,
    binaryPath
  };
}

export function runPostinstall(options = {}) {
  const { logger = console } = options;

  try {
    selectBinaryForCurrentPlatform(options);
    return true;
  } catch (error) {
    logger.warn(
      `[agent-assembly] Failed to verify native binding: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export function isExecutedDirectly(
  moduleUrl = import.meta.url,
  entryPath = process.argv[1]
) {
  return Boolean(entryPath) && moduleUrl === pathToFileURL(entryPath).href;
}

export function runPostinstallEntrypoint(options = {}) {
  const {
    moduleUrl = import.meta.url,
    entryPath = process.argv[1],
    run = () => runPostinstall(options)
  } = options;

  if (isExecutedDirectly(moduleUrl, entryPath)) {
    return run();
  }

  return null;
}

runPostinstallEntrypoint();
