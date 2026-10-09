// eslint-config-next 16 is published as native flat config, so it is spread in
// directly. The previous FlatCompat wrapper existed to bridge the Next 15
// eslintrc-style shareable config; against the 16 package it throws
// "Converting circular structure to JSON" before linting anything.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import importPlugin from "eslint-plugin-import";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Module-boundaries guard: enforce DDD dependency direction.  Domain is the
    // innermost layer and must not import from infrastructure or application —
    // those dependencies must be inverted through ports in application/.
    //
    // src/generated/** is excluded: it is git-ignored machine output compiled
    // from content/photos/*.yaml by scripts/build-catalog.mjs.  It may be
    // absent on a bare checkout, so linting it would fail before any human
    // code is checked.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/generated/**"],
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/domain/**",
              from: ["**/infrastructure/**"],
              message:
                "Domain must not import infrastructure. Route the dependency through an application port.",
            },
            {
              target: "./src/domain/**",
              from: ["**/application/**"],
              message:
                "Domain must not import application. Domain is the core and must not depend on orchestration.",
            },
            {
              target: "./src/application/**",
              from: ["**/infrastructure/**"],
              message:
                "Application must not import infrastructure. Use a port from domain or wire dependencies through the container.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "src/generated/**",
    ],
  },
];

export default eslintConfig;
