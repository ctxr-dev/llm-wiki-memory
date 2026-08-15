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

const REACT = `focus: React And Vite
memory:
  atom_type: decision
  status: active
  area: frontend
  subject:
    - architecture
`;

const REACT_BODY = `# React And Vite

- type: decision
- area: frontend
- tags: react, vite

We use **React** with Vite for the user interface.
`;

const ARCHIVED = `focus: Retired Tooling
memory:
  atom_type: reference
  status: archived
  area: backend
`;

const PROBE = `focus: Probe Note
memory:
  atom_type: investigation
  status: active
`;

const LESSON = `focus: Preserve plan detail on rewrite
memory:
  atom_type: feedback-rule
  status: active
  area: workflow
  task_type: planning
`;

const DIVERGENCE = `focus: RequestId divergence audit note
memory:
  atom_type: bug-root-cause
  status: active
  area: backend
`;

const DIVERGENCE_BODY = `status: verified

subject:
  - audit
  - ofe

# RequestId divergence audit note

The audit topic and the ofe topic showed different requestId values for the same order.
`;

const REFS = `focus: Reference Demo
memory:
  atom_type: investigation
  status: active
`;

const REFS_FILLER = Array.from(
  { length: 40 },
  (_, index) => `Filler paragraph ${index} keeps the escalation register below the fold.`,
).join("\n\n");

const REFS_TREE = `<pre>webapp
  ├─ <a href="brain:knowledge/frontend/decision/architecture/react.md">react.md  :12</a>
  └─ client/Markdown.tsx  :44
</pre>`;

const REFS_BODY = `# Reference Demo

Escalations: \`brain:issues/JIRA/DEV/134/9/6/DEV-134096.md\`

Linked note: \`brain:knowledge/backend/decision/architecture/kafka.md\`

Upstream: [netty release notes](https://example.com/netty)

${REFS_TREE}

Register: E1 still waits for an upstream owner.

${REFS_FILLER}

## Escalated

| Marker | Package | Owner |
| --- | --- | --- |
| **E1** | netty-codec-http | platform |
| **E2** | jackson-databind | platform |
`;

/**
 * A plan that lives under `pending/`, so a reference naming any OTHER lifecycle folder is
 * stale in exactly the way a real tracker plan's references go stale when it transitions.
 */
const MOVED_PLAN = `focus: Moved Demo Plan
status: pending
progress: "0/2"
memory:
  atom_type: plan
  status: active
  area: backend
  subject:
    - architecture
`;

const MOVED_PLAN_BODY = `# Moved Demo

This plan sits under pending; references written earlier name a different folder.
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
  const result = spawnSync(
    process.execPath,
    [path.join(REPO, "scripts/cli.mjs"), "init", "--template", "tracker-issues"],
    {
      env,
      encoding: "utf8",
    },
  );
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
  leaf("knowledge/frontend/decision/architecture/react.md", REACT, REACT_BODY);
  leaf("knowledge/backend/reference/tooling/legacy.md", ARCHIVED, "# Retired\n\nOld notes.\n");
  leaf("knowledge/backend/bug-root-cause/general/divergence.md", DIVERGENCE, DIVERGENCE_BODY);
  leaf("investigations/general/probe.md", PROBE, "# Probe\n\nA lone investigation.\n");
  leaf("investigations/general/refs-demo.md", REFS, REFS_BODY);
  leaf(
    "self_improvement/workflow/planning/general/lesson-preserve-detail.md",
    LESSON,
    "# Preserve detail\n\nAlways diff a plan rewrite before saving.\n",
  );
  leaf("plans/backend/architecture/rollout.md", PLAN, "# Rollout\n\n- [x] one\n- [ ] two\n");
  leaf(
    "issues/JIRA/DEV/134/9/6/pending/DEV-134096-moved-demo.plan.md",
    MOVED_PLAN,
    MOVED_PLAN_BODY,
  );
  for (let i = 0; i < 60; i += 1) {
    const n = String(i).padStart(2, "0");
    leaf(
      `self_improvement/bulk/implementation/general/bulk-${n}.md`,
      `focus: Bulk Doc ${n}\nmemory:\n  atom_type: feedback-rule\n  status: active\n  area: bulk\n  task_type: implementation\n`,
      `# Bulk Doc ${n}\n\nFiller content number ${n}.\n`,
    );
  }
  return dataDir;
}
