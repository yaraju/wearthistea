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
  ]),
  // Issue #20 hard rule: anything joining through Order.designId (order
  // history, order confirmation, admin order views) must NEVER call
  // resolveLatestDesignVersion()/getDesignVersionChain() — an Order always
  // displays the exact Design row it references, even once superseded.
  // Enforced structurally, not as a convention to remember: these files
  // simply can't import the module those functions live in.
  {
    files: [
      "src/app/api/account/orders/**/*.{ts,tsx}",
      "src/app/api/admin/batches/**/*.{ts,tsx}",
      "src/app/account/orders/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/design-versions",
              message:
                "Order-linked design views must never resolve to a different version — an Order always shows the exact Design row it references, even after it's superseded. See src/lib/design-versions.ts's module comment.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
