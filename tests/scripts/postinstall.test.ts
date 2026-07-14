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
    // win32 is not a supported key: no win32 .node is built, so it must NOT map
    // to a phantom `win32-x64-msvc` triple (AAASM-4467).
    expect(detectPlatformKey("win32", "x64")).toBeNull();
    expect(detectPlatformKey("sunos", "x64")).toBeNull();
  });

  it("resolves the bundled binary the same way index.cjs does", () => {
    const cwd = createTempDir();
    const nativeDir = seedBundledBinary(cwd, "index.node");

    // Exact index.node is preferred (platformKey is irrelevant when present).
    expect(findBundledNativeBinary(nativeDir, "linux-x64-gnu")).toBe(
      path.join(nativeDir, "index.node")
    );

    // Falls back to this platform's index.<triple>.node.
    fs.rmSync(path.join(nativeDir, "index.node"));
    fs.writeFileSync(path.join(nativeDir, "index.linux-x64-gnu.node"), "fake");
    expect(findBundledNativeBinary(nativeDir, "linux-x64-gnu")).toBe(
      path.join(nativeDir, "index.linux-x64-gnu.node")
    );

    // Returns null when this platform's triple is not present.
    fs.rmSync(path.join(nativeDir, "index.linux-x64-gnu.node"));
    expect(findBundledNativeBinary(nativeDir, "linux-x64-gnu")).toBeNull();
    expect(findBundledNativeBinary(path.join(cwd, "does-not-exist"), "linux-x64-gnu")).toBeNull();
  });

  // AAASM-4467: with all three per-platform binaries bundled together, the
  // resolver must pick THIS platform's triple — never the first one a directory
  // scan returns. A first-match resolver would load a wrong-arch binary and
  // crash at `require`.
  it("selects the current platform's triple, not the first bundled .node", () => {
    const cwd = createTempDir();
    const nativeDir = seedBundledBinary(cwd, "index.darwin-arm64.node");
    // Stage all three published triples side by side (no plain index.node).
    fs.writeFileSync(path.join(nativeDir, "index.darwin-x64.node"), "fake");
    fs.writeFileSync(path.join(nativeDir, "index.linux-x64-gnu.node"), "fake");

    // Each platform key resolves to its own triple regardless of readdir order.
    expect(findBundledNativeBinary(nativeDir, "linux-x64-gnu")).toBe(
      path.join(nativeDir, "index.linux-x64-gnu.node")
    );
    expect(findBundledNativeBinary(nativeDir, "darwin-x64")).toBe(
      path.join(nativeDir, "index.darwin-x64.node")
    );
    expect(findBundledNativeBinary(nativeDir, "darwin-arm64")).toBe(
      path.join(nativeDir, "index.darwin-arm64.node")
    );

    // A platform whose triple is absent from the bundle resolves to null rather
    // than silently loading a sibling triple.
    expect(findBundledNativeBinary(nativeDir, "win32-x64-msvc")).toBeNull();
  });

  it("selectBinaryForCurrentPlatform picks the triple matching the platform key", () => {
    const cwd = createTempDir();
    const nativeDir = seedBundledBinary(cwd, "index.linux-x64-gnu.node");
    fs.writeFileSync(path.join(nativeDir, "index.darwin-arm64.node"), "fake");

    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = selectBinaryForCurrentPlatform({
      platform: "linux",
      arch: "x64",
      cwd,
      logger
    });

    expect(result?.platformKey).toBe("linux-x64-gnu");
    expect(result?.binaryPath).toBe(path.join(nativeDir, "index.linux-x64-gnu.node"));
    expect(logger.warn).not.toHaveBeenCalled();
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

  // AAASM-4467: Windows is unsupported (no win32 .node is ever built). Rather
  // than resolving a phantom `win32-x64-msvc` triple and throwing a misleading
  // "binding missing" error, postinstall emits an honest, non-error notice and
  // returns cleanly so the install still succeeds.
  it("emits an honest Windows-not-supported notice, not a phantom-binary error", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = selectBinaryForCurrentPlatform({
      platform: "win32",
      arch: "x64",
      logger
    });

    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Windows is not supported yet")
    );
    // No phantom triple leaks into any message, and it is not treated as an error.
    const allMessages = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .flat()
      .join(" ");
    expect(allMessages).not.toContain("win32-x64-msvc");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("runPostinstall succeeds cleanly on Windows (install never hard-fails)", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const ok = runPostinstall({
      platform: "win32",
      arch: "x64",
      logger
    });

    expect(ok).toBe(true);
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
