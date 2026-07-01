import { execSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withPackagingLock } from "./lock.js";

describe("packaging esm resolution", () => {
  it("resolves the ESM entry from the built output", async () => {
    await withPackagingLock(async () => {
      execSync("pnpm run build:esm", { stdio: "pipe" });

      const moduleUrl = pathToFileURL(
        path.resolve(process.cwd(), "dist/esm/index.js")
      ).href;
      const module = await import(moduleUrl);

      expect(typeof module.initAssembly).toBe("function");
    });
  }, 120000);
});
