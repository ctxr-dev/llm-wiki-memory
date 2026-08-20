import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    globals: true,
    setupFiles: ["../../test/setup-guard.mjs"],
    include: [
      "server/**/*.test.mjs",
      "shared/**/*.test.mjs",
      "client/**/*.test.tsx",
      "client/**/*.test.ts",
    ],
    environmentMatchGlobs: [["client/**", "jsdom"]],
  },
});
