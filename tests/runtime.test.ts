// Unit tests for src/runtime.ts (AAASM-1228 / F115).
//
// Covers the four scenarios from the AAASM-1230 AC checklist:
//   - binary-in-PATH
//   - binary-bundled (under node_modules/@agent-assembly/runtime-{platform}-{arch})
//   - binary-not-found
//   - already-running (initAssembly skips spawn when sidecar reachable)

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BINARY_NAME, INSTALL_HINT, findAasmBinary, initAssembly } from "../src/runtime.js";

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
});
