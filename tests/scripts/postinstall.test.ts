import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectPlatformKey,
  findBundledNativeBinary,
  isExecutedDirectly,
  runPostinstallEntrypoint,
  runPostinstall,
  selectBinaryForCurrentPlatform
} from "../../scripts/postinstall.mjs";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.resolve(process.cwd(), ".tmp-postinstall-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Seed a bundled native binding under `native/aa-ffi-node/` in a temp cwd,
 * mirroring the actually-published layout (the `.node` ships in-package and is
 * resolved by native/aa-ffi-node/index.cjs — not from a separate npm package).
 */
function seedBundledBinary(cwd: string, fileName: string) {
  const nativeDir = path.join(cwd, "native", "aa-ffi-node");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, fileName), "fake-native-binary");
  return nativeDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("postinstall script", () => {
  it("maps platform and arch to supported platform keys", () => {
    expect(detectPlatformKey("linux", "x64")).toBe("linux-x64-gnu");
    expect(detectPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectPlatformKey("win32", "x64")).toBe("win32-x64-msvc");
    expect(detectPlatformKey("sunos", "x64")).toBeNull();
  });

  it("resolves the bundled binary the same way index.cjs does", () => {
    const cwd = createTempDir();
    const nativeDir = seedBundledBinary(cwd, "index.node");

    // Exact index.node is preferred.
    expect(findBundledNativeBinary(nativeDir)).toBe(path.join(nativeDir, "index.node"));

    // Falls back to a platform-suffixed index.<triple>.node.
    fs.rmSync(path.join(nativeDir, "index.node"));
    fs.writeFileSync(path.join(nativeDir, "index.linux-x64-gnu.node"), "fake");
    expect(findBundledNativeBinary(nativeDir)).toBe(
      path.join(nativeDir, "index.linux-x64-gnu.node")
    );

    // Returns null when no binding is present.
    fs.rmSync(path.join(nativeDir, "index.linux-x64-gnu.node"));
    expect(findBundledNativeBinary(nativeDir)).toBeNull();
    expect(findBundledNativeBinary(path.join(cwd, "does-not-exist"))).toBeNull();
  });

  it("confirms the bundled binding present for the current platform", () => {
    const cwd = createTempDir();
    seedBundledBinary(cwd, "index.node");

    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    const result = selectBinaryForCurrentPlatform({
      platform: "linux",
      arch: "x64",
      cwd,
      logger
    });

    expect(result?.platformKey).toBe("linux-x64-gnu");
    expect(result?.binaryPath).toBe(
      path.join(cwd, "native", "aa-ffi-node", "index.node")
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[agent-assembly] Native binding present for linux-x64-gnu: index.node"
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns null and warns for unsupported platforms", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    const result = selectBinaryForCurrentPlatform({
      platform: "freebsd",
      arch: "arm64",
      logger
    });

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[agent-assembly] Unsupported platform: freebsd-arm64; skipping native binding check."
    );
  });

  it("returns true when the bundled binding is present", () => {
    const cwd = createTempDir();
    seedBundledBinary(cwd, "index.darwin-arm64.node");

    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    const ok = runPostinstall({
      platform: "darwin",
      arch: "arm64",
      cwd,
      logger
    });

    expect(ok).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns false and warns loudly when no bundled binding is found", () => {
    const cwd = createTempDir();
    // native/aa-ffi-node exists but ships no .node — a provisioning regression.
    fs.mkdirSync(path.join(cwd, "native", "aa-ffi-node"), { recursive: true });

    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    const ok = runPostinstall({
      platform: "linux",
      arch: "x64",
      cwd,
      logger
    });

    expect(ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain(
      "[agent-assembly] Failed to verify native binding: No bundled native binding (.node) found in native/aa-ffi-node for linux-x64-gnu"
    );
  });

  it("stringifies non-Error throwables when logging postinstall failure", () => {
    const cwd = createTempDir();
    seedBundledBinary(cwd, "index.node");

    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    const readSpy = vi.spyOn(fs, "existsSync").mockImplementation(() => {
      throw "raw-failure";
    });

    const ok = runPostinstall({
      platform: "linux",
      arch: "x64",
      cwd,
      logger
    });

    expect(ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[agent-assembly] Failed to verify native binding: raw-failure"
    );

    readSpy.mockRestore();
  });

  it("detects direct execution and runs entrypoint only in main mode", () => {
    const modulePath = path.resolve("tmp-postinstall-entrypoint.mjs");
    const moduleUrl = pathToFileURL(modulePath).href;
    const otherPath = path.resolve("tmp-postinstall-other.mjs");

    expect(isExecutedDirectly(moduleUrl, modulePath)).toBe(true);
    expect(isExecutedDirectly(moduleUrl, otherPath)).toBe(false);

    const runSpy = vi.fn(() => true);

    expect(
      runPostinstallEntrypoint({
        moduleUrl,
        entryPath: modulePath,
        run: runSpy
      })
    ).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(1);

    expect(
      runPostinstallEntrypoint({
        moduleUrl,
        entryPath: otherPath,
        run: runSpy
      })
    ).toBeNull();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
