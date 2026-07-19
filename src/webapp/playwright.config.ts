import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFixtureWiki } from "./e2e/seed.mjs";

const dataDir = createFixtureWiki();
fs.writeFileSync(path.join(os.tmpdir(), "lwm-e2e-datadir"), dataDir);
const port = 4817;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalTeardown: "./e2e/teardown.mjs",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { defaultBrowserType: "chromium" } }],
  webServer: {
    command: "node server/index.mjs",
    port,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      MEMORY_DATA_DIR: dataDir,
      MEMORY_EMBED_BACKEND: "lexical",
      PORT: String(port),
      LWM_WEBAPP_HOST: "127.0.0.1",
    },
  },
});
