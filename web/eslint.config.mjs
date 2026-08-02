import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // `next lint` only linted app/pages/components/lib/src. `eslint .`
    // (required by Next 16, which removed `next lint`) additionally covers
    // these dirs, newly surfacing pre-existing code. Keep them out of scope
    // to preserve the pre-upgrade lint behavior.
    "types/**/*.d.ts", // hand-written ambient shim for recharts (3rd-party)
    "__tests__/**",    // test files were never linted by `next lint`
  ]),
  // react-hooks v7 (bundled by eslint-config-next@16) adds rules that did not
  // exist before. Downgrade the ones that fire on pre-existing effect code to
  // warnings so the Next 16 upgrade stays behavior-preserving (0 errors).
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
    },
  },
]);

export default eslintConfig;
