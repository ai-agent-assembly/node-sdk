// Unit tests for src/runtime.ts (AAASM-1228 / F115).
//
// Covers the four scenarios from the AAASM-1230 AC checklist:
//   - binary-in-PATH
//   - binary-bundled (under node_modules/@agent-assembly/runtime-{platform}-{arch})
//   - binary-not-found
//   - already-running (initAssembly skips spawn when sidecar reachable)

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
