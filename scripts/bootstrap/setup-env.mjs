#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "../lib/atomic-write.mjs";

// Write the settings/.env on a FRESH install (one JS path — no BSD/GNU `sed`
// fork). CREATE-ONLY: an existing .env is NEVER modified (env.mjs's
// process-env-then-file precedence makes the file win); we only read its
// provider for the log. Byte-parity with the old sed: the provider line is a
// whole-line replace anchored at `^MEMORY_LLM_PROVIDER=`; base_url is
// replace-if-present (anchored, so the commented template line does NOT match)
// else appended as `\nMEMORY_LLM_BASE_URL=<hint>\n`.

/**
 * @param {string} raw
 * @returns {string}
 */
function readProvider(raw) {
  const m = raw.match(/^MEMORY_LLM_PROVIDER=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

/**
 * @param {{ dataDir: string, templatePath: string, provider: string, baseUrlHint?: string }} opts
 * @returns {{ action: "kept" | "wrote", provider: string, existingProvider?: string }}
 */
export function writeEnvFile({ dataDir, templatePath, provider, baseUrlHint }) {
  const envFile = path.join(dataDir, "settings", ".env");
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  if (fs.existsSync(envFile)) {
    return {
      action: "kept",
      provider,
      existingProvider: readProvider(fs.readFileSync(envFile, "utf8")),
    };
  }
  let content = fs.readFileSync(templatePath, "utf8");
  content = content.replace(/^MEMORY_LLM_PROVIDER=.*$/m, `MEMORY_LLM_PROVIDER=${provider}`);
  if (baseUrlHint) {
    content = /^MEMORY_LLM_BASE_URL=/m.test(content)
      ? content.replace(/^MEMORY_LLM_BASE_URL=.*$/m, `MEMORY_LLM_BASE_URL=${baseUrlHint}`)
      : `${content}\nMEMORY_LLM_BASE_URL=${baseUrlHint}\n`;
  }
  writeFileAtomic(envFile, content);
  return { action: "wrote", provider };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [dataDir, templatePath, provider, baseUrlHint] = process.argv.slice(2);
  if (!dataDir || !templatePath || !provider) {
    console.error("usage: setup-env.mjs <dataDir> <templatePath> <provider> [baseUrlHint]");
    process.exit(1);
  }
  const r = writeEnvFile({ dataDir, templatePath, provider, baseUrlHint });
  console.error(
    `env: ${r.action} (provider=${r.action === "kept" ? r.existingProvider : provider})`,
  );
}
