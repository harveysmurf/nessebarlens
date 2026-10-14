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
    // Typed linting (#389). The `no-unsafe-*` rules are the only ones that stop
    // an `any` from *flowing* — `no-explicit-any` catches the ones we write and
    // says nothing about the ones a dependency hands us. Enabling them needs
    // type information, which means the parser has to be told about the project.
    //
    // Scoped to `src/**` on purpose. `projectService` resolves each file against
    // the *nearest* tsconfig, and the nearest tsconfig for `tests/` is the root
    // one — which excludes `tests`. Widening the scope to the test suite would
    // either fail on "file not found in project" or quietly type-check the suite
    // against a config it is not part of. `tests/tsconfig.tests-check.json` is
    // the suite's own program; wiring it in is its own change.
    //
    // `scripts/**` is `.mjs` and deliberately not in any tsconfig, so typed
    // linting cannot reach it without adding a config that does not exist for a
    // reason.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/generated/**"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
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
