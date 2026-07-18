import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSdkVersion } from "../../src/native/client.js";

/**
 * Regression guard for AAASM-4821.
 *
 * `resolveSdkVersion` (src/native/client.ts) does
 * `require("@agent-assembly/sdk/package.json")` so the *npm* package version —
 * not the shared crate version — is signed into the runtime handshake
 * (AAASM-3683). That require resolves through this package's own `exports` map
 * (Node self-referencing). If `./package.json` is not exported, Node throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, `resolveSdkVersion` swallows it and returns
 * `undefined` in every real install — silently degrading downgrade detection.
 *
 * The pre-existing unit tests mock `require`, so they never exercise the real
 * exports map and could not catch the missing subpath. These assertions run
 * against the real map.
 */
describe("package.json exports (AAASM-4821)", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
  ) as {
    version: string;
    exports: Record<string, string | Record<string, string>>;
  };

  it("resolveSdkVersion resolves the real npm version via the exports map", () => {
    // End-to-end: exercises the actual self-referencing exports resolution,
    // not a mocked require. Before the ./package.json export existed this
    // returned undefined.
    expect(resolveSdkVersion()).toBe(pkg.version);
  });

  it("exports ./package.json to itself so the subpath require resolves", () => {
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });

  it("lists the types condition first in every conditional export (AAASM-4830)", () => {
    // node16/nodenext resolution and esbuild require `types` before
    // import/require; a types-last condition is unreachable.
    for (const [subpath, condition] of Object.entries(pkg.exports)) {
      if (typeof condition !== "object") continue;
      const keys = Object.keys(condition);
      if (!keys.includes("types")) continue;
      expect(keys[0], `types must be first in exports["${subpath}"]`).toBe(
        "types"
      );
    }
  });
});
