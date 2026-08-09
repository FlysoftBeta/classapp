import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  globalIgnores([
    "dist/**",
    "build/**",
    ".cache/**",
    "worktree/**",
    "lib/infini/**",
    "lib/zstd-web/pkg/**",
    "deploy_test/**",
    "vendor/**",
    "lib/**/rust/target/**",
    "client/components/learning/**",
    "server/services/wordsService.ts",
  ]),
]);
