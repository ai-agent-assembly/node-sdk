import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPackagingLock } from "./lock.js";

describe("packaging langchain lazy-load", () => {
  it("init-assembly does not statically import the LangChain adapter", async () => {
    await withPackagingLock(() => {
      execSync("pnpm run build:esm", { stdio: "pipe" });

      const initAssembly = fs.readFileSync(
        path.resolve(process.cwd(), "dist/esm/core/init-assembly.js"),
        "utf8"
      );

      // A top-level static import of the adapter would eagerly pull in the
      // optional @langchain/core peer and break `import "@agent-assembly/sdk"`
      // for consumers that don't use LangChain (AAASM-2872).
      expect(initAssembly).not.toMatch(/^\s*import\s[^;]*adapters\/langchain/m);

      // It must instead be loaded lazily, only on the langchain code path.
      expect(initAssembly).toMatch(/await import\(\s*["']\.\.\/adapters\/langchain/);
    });
  }, 120000);
});
