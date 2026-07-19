import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const KNOWLEDGE = `focus: Kafka choice
memory:
  atom_type: decision
  status: active
  area: backend
  subject:
    - architecture
`;

const KNOWLEDGE_BODY = `# Kafka

We chose **Kafka** for the event bus.

| Option | Verdict |
| --- | --- |
| Kafka | yes |
| RabbitMQ | no |

\`\`\`js
const topic = "events";
\`\`\`
`;

const PLAN = `focus: Rollout plan
status: in-progress
progress: "2/5"
memory:
  atom_type: plan
  status: active
  area: backend
  subject:
    - architecture
`;

export function createFixtureWiki() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-e2e-"));
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings", "settings.yaml"), "embed:\n  backend: lexical\n");
  const env = {
    ...process.env,
    MEMORY_DATA_DIR: dataDir,
    MEMORY_DEFAULT_PROJECT_MODULE: "e2e",
    MEMORY_EMBED_BACKEND: "lexical",
    LLM_WIKI_SKILL_CLI: path.join(REPO, "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs"),
    LLM_WIKI_NO_PROMPT: "1",
    LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
  };
  const result = spawnSync(process.execPath, [path.join(REPO, "scripts/cli.mjs"), "init"], {
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`fixture wiki init failed: ${result.stderr || result.stdout}`);
  }
  const wiki = path.join(dataDir, "wiki");
  const leaf = (rel, frontmatter, body) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `---\n${frontmatter}---\n${body}\n`);
  };
  leaf("knowledge/backend/decision/architecture/kafka.md", KNOWLEDGE, KNOWLEDGE_BODY);
  leaf("plans/backend/architecture/rollout.md", PLAN, "# Rollout\n\n- [x] one\n- [ ] two\n");
  return dataDir;
}
