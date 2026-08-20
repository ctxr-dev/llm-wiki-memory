import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function teardown() {
  const marker = path.join(os.tmpdir(), "lwm-e2e-datadir");
  if (!fs.existsSync(marker)) return;
  const dataDir = fs.readFileSync(marker, "utf8").trim();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
}
