import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "corpus/dist/**",
      "packages/api/drizzle/**",
      "data/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // The web imports @contractix/shared/schemas directly, so nothing reachable
    // from there may touch Node built-ins — the package root pulls `node:fs` via
    // the models loader, which is exactly why the subpath exists. Mechanical,
    // so the constraint survives someone adding a convenient helper.
    files: ["packages/shared/src/schemas/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "path", "url", "crypto"],
              message:
                "packages/shared/src/schemas must stay browser-safe — the web imports it directly.",
            },
          ],
        },
      ],
    },
  },
  {
    // Only the web renders React. typescript-eslint catches none of the
    // rules-of-hooks class of bug, and the streaming hooks — which own an
    // AbortController and bail early on an aborted signal — are exactly where an
    // early return before a hook would hide.
    files: ["packages/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"], jsxA11y.flatConfigs.recommended],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
