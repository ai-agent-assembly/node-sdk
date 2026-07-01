import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPackagingLock } from "./lock.js";
import { execNpm } from "./npm-command.js";

interface NpmPackEntry {
  filename: string;
}

describe("packaging npm pack contents", () => {
  it("excludes source files and includes dist output", async () => {
    await withPackagingLock(() => {
      execSync("pnpm run build", { stdio: "pipe" });

      const packDir = fs.mkdtempSync(path.resolve(process.cwd(), ".pack-"));

      // Pass the temp-dir path as a discrete argument (no shell interpolation):
      // packDir is derived from an absolute cwd path that may contain spaces or
      // shell metacharacters, which would corrupt a shell-built command string.
      const packEntries = JSON.parse(
        execNpm(
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--cache",
            "./.npm-cache",
            "--pack-destination",
            packDir
          ],
          { encoding: "utf8", stdio: "pipe" }
        )
      ) as NpmPackEntry[];

      const tarballName = packEntries[0]?.filename;
      expect(tarballName).toBeTruthy();

      const tarballPath = path.resolve(packDir, tarballName!);
      // Same rationale: tarballPath is an absolute path; pass it as an argument
      // rather than interpolating it into a shell command string.
      const packedFiles = execFileSync("tar", ["-tf", tarballPath], {
        encoding: "utf8",
        stdio: "pipe"
      })
        .split("\n")
        .filter(Boolean);

      expect(
        packedFiles.some((entry) => entry.startsWith("package/dist/"))
      ).toBe(true);
      expect(
        packedFiles.some((entry) => entry.startsWith("package/src/"))
      ).toBe(false);
      expect(
        packedFiles.some((entry) => entry.startsWith("package/tests/"))
      ).toBe(false);

      fs.rmSync(packDir, { recursive: true, force: true });
    });
  }, 90000);
});
