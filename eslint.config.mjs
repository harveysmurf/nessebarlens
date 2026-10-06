// eslint-config-next 16 is published as native flat config, so it is spread in
// directly. The previous FlatCompat wrapper existed to bridge the Next 15
// eslintrc-style shareable config; against the 16 package it throws
// "Converting circular structure to JSON" before linting anything.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
