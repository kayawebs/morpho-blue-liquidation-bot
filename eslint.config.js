// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginImportX from "eslint-plugin-import-x";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";

export default tseslint.config({ ignores: ["dist"] }, eslint.configs.recommended, {
  extends: [
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    eslintPluginImportX.flatConfigs.recommended,
    eslintPluginImportX.flatConfigs.typescript,
    eslintPluginPrettierRecommended,
  ],
  files: ["**/*.ts"],
  languageOptions: {
    ecmaVersion: 2022,
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: {
    "@typescript-eslint": tseslint.plugin,
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    "@typescript-eslint/restrict-template-expressions": ["off"],
    "import-x/no-unresolved": [
      "error",
      { ignore: ["ponder:api", "ponder:registry", "ponder:schema"] },
    ],
    "import-x/order": [
      "error",
      {
        "newlines-between": "always",
        alphabetize: {
          order: "asc",
          caseInsensitive: true,
        },
        pathGroups: [
          {
            pattern: "ponder*",
            group: "external",
          },
        ],
      },
    ],
  },
  // Looser rules for worker + ponder runtime code to speed iteration
  // (keeps core packages strict)
},
{
  files: [
    "apps/ponder/src/**/*.ts",
    "apps/workers/**/*.ts",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unsafe-assignment": "off",
    "@typescript-eslint/no-unsafe-member-access": "off",
    "@typescript-eslint/no-unsafe-argument": "off",
    "@typescript-eslint/no-floating-promises": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/prefer-nullish-coalescing": "off",
    "@typescript-eslint/no-redundant-type-constituents": "off",
    "no-empty": "off",
  },
});
