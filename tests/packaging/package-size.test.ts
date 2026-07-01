import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPackagingLock } from "./lock.js";
import { execNpm } from "./npm-command.js";

interface NpmPackEntry {
  filename: string;
}

const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;

describe("packaging size budget", () => {
  it("keeps packed artifact under 5MB", async () => {
    await withPackagingLock(() => {
      execSync("pnpm run build", { stdio: "pipe" });

      const packDir = fs.mkdtempSync(path.resolve(process.cwd(), ".pack-"));

      // Pass the temp-dir path as a discrete argument. On Windows, shell-built
      // command strings can corrupt absolute paths used as npm arguments.
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
      const tarballStat = fs.statSync(tarballPath);

      expect(tarballStat.size).toBeLessThan(MAX_PACKAGE_BYTES);

      fs.rmSync(packDir, { recursive: true, force: true });
    });
  }, 90000);
});
