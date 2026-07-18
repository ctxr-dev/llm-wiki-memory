import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.mjs", "shared/**/*.test.mjs"],
  },
});
