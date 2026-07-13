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
      "docs/api/**",
      // Vendored quick-start snippets (AAASM-4514): verbatim excerpts of the
      // examples repo's runnable regions, not compiled by any tsconfig. They are
      // doc fixtures, not source — linting them trips the typed-project parser.
      "metadata/quickstart-snippets/**"
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
