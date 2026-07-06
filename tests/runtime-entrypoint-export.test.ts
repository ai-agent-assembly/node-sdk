// AAASM-1221: the runtime binary resolution helpers must be reachable
// from the SDK's top-level entrypoint, not just from `src/runtime.ts`
// or the `@agent-assembly/sdk/runtime` subpath. Consumers should be
// able to discover the `aasm` binary location without having to know
// the runtime-helpers ship in a sub-module.
import { describe, expect, it } from "vitest";

import { INSTALL_HINT, findAasmBinary } from "../src/index.js";

describe("SDK entrypoint — runtime helpers re-export (AAASM-1221)", () => {
  it("re-exports findAasmBinary as a callable function", () => {
    expect(typeof findAasmBinary).toBe("function");
    // The function returns either a string path or null depending on
    // the host machine; assert the union without asserting the value.
    const result = findAasmBinary();
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("re-exports INSTALL_HINT as the canonical not-found error message", () => {
    expect(typeof INSTALL_HINT).toBe("string");
    expect(INSTALL_HINT).toContain("agent-assembly runtime not found");
  });

  // AAASM-4192: the hint must never point users at the unscoped, unregistered
  // (claimable) `agent-assembly` npm name — that is a supply-chain squat vector.
  // Any npm install guidance must use the scoped `@agent-assembly/...` package.
  it("never suggests installing the claimable unscoped npm name", () => {
    expect(INSTALL_HINT).not.toMatch(/(?:pnpm add|npm i(?:nstall)?|yarn add)\s+agent-assembly\b/);
    expect(INSTALL_HINT).toContain("@agent-assembly/sdk");
  });
});
