// Unit tests for src/runtime.ts (AAASM-1228 / F115).
//
// Covers the four scenarios from the AAASM-1230 AC checklist:
//   - binary-in-PATH
//   - binary-bundled (under node_modules/@agent-assembly/runtime-{platform}-{arch})
//   - binary-not-found
//   - already-running (initAssembly skips spawn when sidecar reachable)

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { describe, expect, it } from "vitest";

import {
  BINARY_NAME,
  ENV_AUTO_START,
  INSTALL_HINT,
  RUNTIME_LOG_FILENAME,
  USER_LOCAL_BIN,
  assertSafeBinaryPath,
  findAasmBinary,
  initAssembly,
  startRuntime,
} from "../src/runtime.js";

function makeFakeAasm(dir: string): string {
  const path = join(dir, BINARY_NAME);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function makeBundledRuntimePackage(root: string): string {
  const pkgDir = join(root, "node_modules", "@agent-assembly", `runtime-${platform()}-${arch()}`);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: `@agent-assembly/runtime-${platform()}-${arch()}` }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-bundled-runtime" }));
  return makeFakeAasm(join(pkgDir, "bin"));
}

describe("runtime — F115 lifecycle", () => {
  it("findAasmBinary returns the resolved path when binary is on $PATH", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aasm-path-"));
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    try {
      const fake = makeFakeAasm(tmp);
      process.env.PATH = tmp;
      process.env.HOME = "/var/empty-aasm-no-home";

      expect(findAasmBinary()).toBe(fake);
    } finally {
      process.env.PATH = originalPath;
      process.env.HOME = originalHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("findAasmBinary returns the bundled-runtime path when the npm optional sub-package is installed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aasm-bundled-"));
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    try {
      const fake = makeBundledRuntimePackage(tmp);
      process.chdir(tmp);
      process.env.PATH = join(tmp, "no-such-path");
      process.env.HOME = join(tmp, "no-such-home");

      // createRequire.resolve canonicalises symlinks (on macOS, /var/folders
      // → /private/var/folders); compare against the realpath form.
      expect(findAasmBinary()).toBe(realpathSync(fake));
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
      process.env.HOME = originalHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("initAssembly throws Error with INSTALL_HINT when binary not found and auto-start opted in", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aasm-missing-"));
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    const originalAutoStart = process.env[ENV_AUTO_START];
    try {
      // Empty cwd (no node_modules), empty PATH/HOME → every search path misses.
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "test-missing" }));
      process.chdir(tmp);
      process.env.PATH = join(tmp, "no-such-path");
      process.env.HOME = join(tmp, "no-such-home");
      process.env[ENV_AUTO_START] = "1";

      await expect(initAssembly()).rejects.toThrowError(INSTALL_HINT);
      await expect(initAssembly()).rejects.toThrowError(/agent-assembly runtime not found/);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
      process.env.HOME = originalHome;
      if (originalAutoStart === undefined) delete process.env[ENV_AUTO_START];
      else process.env[ENV_AUTO_START] = originalAutoStart;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("initAssembly refuses to auto-start when AA_AUTO_START is unset", async () => {
    const originalAutoStart = process.env[ENV_AUTO_START];
    try {
      delete process.env[ENV_AUTO_START];
      // No sidecar listens on this ephemeral-but-unbound port; the gate must
      // fire before any binary lookup or spawn.
      await expect(initAssembly(undefined, 7879)).rejects.toThrow(/auto-start is disabled/);
    } finally {
      if (originalAutoStart === undefined) delete process.env[ENV_AUTO_START];
      else process.env[ENV_AUTO_START] = originalAutoStart;
    }
  });

  it("assertSafeBinaryPath rejects relative and untrusted-location binaries", () => {
    expect(() => assertSafeBinaryPath("aasm")).toThrow(/non-absolute/);
    expect(() => assertSafeBinaryPath("/tmp/evil/aasm")).toThrow(/untrusted location/);
    expect(() => assertSafeBinaryPath(join(USER_LOCAL_BIN, BINARY_NAME))).not.toThrow();
  });

  it("startRuntime spawns a detached subprocess and appends to the runtime log", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aasm-spawn-"));
    try {
      const child = startRuntime(execPath, 7980, tmp);

      expect(typeof child.pid).toBe("number");
      // The log file is opened (O_APPEND) before the spawn, so it exists
      // synchronously regardless of how fast the detached child exits.
      expect(existsSync(join(tmp, RUNTIME_LOG_FILENAME))).toBe(true);

      // Best-effort terminate in case the (trivially-exiting) child is still
      // alive; the spawn is detached + unref'd so it cannot keep the loop open.
      try {
        if (child.pid !== undefined) process.kill(child.pid);
      } catch {
        // Already exited — nothing to reap.
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("initAssembly is idempotent when a sidecar is already running on the target port", async () => {
    // Bind an ephemeral port and pass it explicitly; this avoids a fixed-port
    // collision with whatever might be on 7878 on the host machine.
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      throw error;
    }
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected AddressInfo from createServer().address()");
    }
    const port = address.port;

    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    try {
      // Pre-load every search path with a guaranteed miss; the orchestrator
      // should still succeed because is_running short-circuits ahead of
      // findAasmBinary.
      process.env.PATH = "/var/empty-aasm-no-path";
      process.env.HOME = "/var/empty-aasm-no-home";

      await expect(initAssembly(undefined, port)).resolves.toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      process.env.HOME = originalHome;
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
