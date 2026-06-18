import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts", "scripts/**/*.mjs"],
      // src/proto/generated/* is protoc-gen-ts_proto output (marked "DO NOT
      // EDIT"); its serialization codecs are exercised transitively, not
      // unit-tested. Excluding generated code from coverage is standard and
      // keeps the metric focused on hand-written SDK behaviour.
      exclude: ["**/*.d.mts", "src/proto/generated/**"]
    }
  }
});
