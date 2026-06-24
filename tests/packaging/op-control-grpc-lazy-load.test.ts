import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPackagingLock } from "./lock.js";

/**
 * Regression guard for AAASM-3505 (a regression from AAASM-3500 / PR #172).
 *
 * `op-control.ts` is re-exported from the package entrypoint (`OpControlSubscriber`).
 * If it imports `@grpc/grpc-js` — directly, or transitively via the grpc-importing
 * `./proto/generated/policy.js` — as a module-scope *value*, then merely doing
 * `import "@agent-assembly/sdk"` eagerly loads grpc at module-load time. That broke
 * consumers where grpc-js isn't resolvable from this module's location (a
 * `file:`-linked SDK under pnpm — the agent-assembly integration-tests node fixture),
 * with `ERR_MODULE_NOT_FOUND: Cannot find package '@grpc/grpc-js'`, taking down 4
 * agent-assembly `e2e_sdk_node` E2E tests.
 *
 * grpc must load lazily — only when a subscriber opens a *real* channel.
 */
describe("packaging op-control grpc lazy-load", () => {
  it("does not statically import @grpc/grpc-js as a runtime value", async () => {
    await withPackagingLock(() => {
      execSync("pnpm run build", { stdio: "pipe" });

      // ESM build: no top-level static value import of grpc-js (a bare
      // `import "@grpc/grpc-js"` or `import { x } from "@grpc/grpc-js"`); the
      // only grpc reference must be a lazy `await import(...)`. Type-only
      // imports are erased by tsc, so they never appear in the emitted JS.
      const esm = fs.readFileSync(path.resolve(process.cwd(), "dist/esm/op-control.js"), "utf8");
      expect(esm).not.toMatch(/^\s*import\s[^;]*["']@grpc\/grpc-js["']/m);
      expect(esm).toMatch(/await import\(\s*["']@grpc\/grpc-js["']\s*\)/);

      // CJS build: tsc lowers `await import(...)` to a lazy
      // `Promise.resolve().then(() => require("@grpc/grpc-js"))`, so the
      // require must NOT be a top-level statement. Assert no `require("@grpc/grpc-js")`
      // appears at the start of a line (top-level), only inside the deferred
      // `.then(...)` callback.
      const cjs = fs.readFileSync(path.resolve(process.cwd(), "dist/cjs/op-control.js"), "utf8");
      expect(cjs).not.toMatch(
        /^\s*(?:const|let|var)\s[^=]*=\s*require\(\s*["']@grpc\/grpc-js["']/m
      );
    });
  }, 120000);

  it("importing the built op-control entry does not load @grpc/grpc-js", async () => {
    await withPackagingLock(() => {
      execSync("pnpm run build", { stdio: "pipe" });

      // Require the built CJS module in a fresh Node process and assert grpc-js
      // is absent from require.cache afterwards. Constructing a subscriber on
      // the test-seam (`clientFactory`) path must also stay grpc-free — only a
      // real-channel connect may pull grpc. A non-zero exit (or thrown
      // ERR-not-found) fails the test.
      const opControlEntry = path.resolve(process.cwd(), "dist/cjs/op-control.js");
      const probe = `
        const mod = require(${JSON.stringify(opControlEntry)});
        // Exercise the test-seam path: must not open a real channel / load grpc.
        const sub = mod.OpControlSubscriber.connect("localhost:7391", {
          orgId: "o", teamId: "t", agentId: "a",
          clientFactory: () => ({ opControlStream: () => ({ on() {}, cancel() {} }) }),
        });
        sub.close();
        const grpcLoaded = Object.keys(require.cache).some((k) =>
          k.includes(${JSON.stringify(path.join("node_modules", "@grpc", "grpc-js"))}),
        );
        if (grpcLoaded) {
          console.error("FAIL: @grpc/grpc-js was eagerly loaded");
          process.exit(1);
        }
        console.log("OK: grpc-js absent from require.cache");
        process.exit(0);
      `;
      // Run the probe in a clean child process. `execFileSync` throws on a
      // non-zero exit (the grpc-loaded failure path above), and we additionally
      // assert on the explicit success marker so the lazy-load guarantee is
      // checked positively rather than only via the absence of a throw.
      const probeOutput = execFileSync(process.execPath, ["-e", probe], {
        stdio: "pipe",
        encoding: "utf8",
      });
      expect(probeOutput).toContain("OK: grpc-js absent from require.cache");
    });
  }, 120000);
});
