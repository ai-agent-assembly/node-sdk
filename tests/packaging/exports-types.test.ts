import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPackagingLock } from "./lock.js";

describe("packaging export types", () => {
  it("points exports types to an existing declaration file", async () => {
    await withPackagingLock(() => {
      execSync("pnpm run build:esm", { stdio: "pipe" });

      const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
      ) as {
        exports: { ".": { types: string } };
      };

      expect(packageJson.exports["."].types).toBe("./dist/types/index.d.ts");
      expect(
        fs.existsSync(path.resolve(process.cwd(), "dist/types/index.d.ts"))
      ).toBe(true);
    });
  }, 120000);
});
