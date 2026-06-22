import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "native/**/target/**",
      "native/aa-ffi-node/index.cjs",
      "native/aa-ffi-node/index.d.ts",
      "website/**",
      "docs/api/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.build.json", "./tsconfig.test.json"]
      }
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly"
      }
    }
  },
  {
    // CommonJS pnpm install hook — runs in pnpm's Node context, not the SDK.
    files: [".pnpmfile.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "readonly",
        require: "readonly"
      }
    }
  }
);
