import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    // `**/` also covers worktree copies of the app (e.g. .kilo/worktrees/*),
    // where the same vendored file otherwise gets linted.
    "public/opus/**",
    "**/public/opus/**",
  ]),
]);

export default eslintConfig;
