import { execSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { withPackagingLock } from "./lock.js";

const requireFromHere = createRequire(import.meta.url);

describe("packaging cjs resolution", () => {
  it("resolves the CJS entry from the built output", async () => {
    await withPackagingLock(() => {
      execSync("pnpm run build:cjs", { stdio: "pipe" });

      const modulePath = path.resolve(process.cwd(), "dist/cjs/index.js");
      const module = requireFromHere(modulePath) as { initAssembly: unknown };

      expect(typeof module.initAssembly).toBe("function");
    });
  }, 120000);
});
