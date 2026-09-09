// Structure-shaped examples: lanes, hierarchy, containment and data model.
// swimlane, tree, org-chart, nested and er. Split from graph.mjs to stay under
// the 300-line file gate; the two share one subject and one slug namespace.
// Every spec draws from the same fictional subject: the llm-wiki-memory
// engine itself (capture hooks, distillation, compile, embeddings, recall,
// the MCP server, the git-backed wiki, and the hourly cron).

/** @type {{kind: string, name: string, caption: string, spec: any}[]} */
export const graphStructureExamples = [
  {
    kind: "swimlane",
    name: "capture-to-recall-lanes",
    caption:
      "One capture-to-recall pass crossing four owners: the hook, the engine, the LLM, and the wiki.",
    spec: {
      kind: "swimlane",
      id: "gx-lanes",
      title: "Capture-to-recall handoffs",
      lanes: [
        { id: "hook", label: "claude code hook" },
        { id: "engine", label: "engine" },
        { id: "llm", label: "llm provider" },
        { id: "wiki", label: "wiki" },
      ],
      steps: [
        { id: "s1", lane: "hook", col: 0, label: "PostToolUse fires" },
        { id: "s2", lane: "engine", col: 0, label: "flush worker reads turns" },
        { id: "s3", lane: "llm", col: 1, label: "distill-by-chunks", sub: "map-reduce" },
        { id: "s4", lane: "wiki", col: 2, label: "write daily atom", sub: "daily/2026-08-28.md" },
        { id: "s5", lane: "engine", col: 2, label: "compile step", kind: "focal" },
        {
          id: "s6",
          lane: "wiki",
          col: 3,
          label: "write leaf + auto-commit",
          sub: "knowledge/, self_improvement/",
        },
        { id: "s7", lane: "engine", col: 3, label: "embed + chunked vector search" },
      ],
      edges: [
        { from: "s1", to: "s2", kind: "sync", label: "spawn worker (pid, session, turns)" },
        { from: "s2", to: "s3", kind: "async", label: "raw turns" },
        { from: "s3", to: "s4", kind: "store", label: "N atom(s)" },
        { from: "s4", to: "s5", kind: "async", label: "hourly cron: cli.mjs compile" },
        { from: "s5", to: "s6", kind: "store", label: "promote decision/lesson atom" },
        { from: "s6", to: "s7", kind: "focal", label: "cli.mjs warm: embed cold leaves" },
      ],
    },
  },
  {
    kind: "tree",
    name: "embedding-module-tree",
    caption:
      "The embedding subsystem's module ownership: backends, cache, and chunking, each broken into concrete files.",
    spec: {
      kind: "tree",
      id: "gx-embed-tree",
      title: "Embedding subsystem ownership",
      nodes: [
        { id: "embedRoot", label: "embedding subsystem", sub: "scripts/lib/embed/" },
        { id: "backends", parent: "embedRoot", label: "backends", sub: "pluggable model runtime" },
        { id: "cacheGroup", parent: "embedRoot", label: "cache", sub: "per-category, on disk" },
        { id: "chunking", parent: "embedRoot", label: "chunking", sub: "split before embed" },
        {
          id: "transformersBackend",
          parent: "backends",
          label: "transformers.js backend",
          sub: "embeddinggemma-300m",
          kind: "focal",
        },
        {
          id: "apiBackend",
          parent: "backends",
          label: "api backend",
          sub: "openai-compatible endpoint",
        },
        {
          id: "perCategoryCache",
          parent: "cacheGroup",
          label: "per-category cache",
          sub: ".embeddings/embeddings.json",
        },
        {
          id: "cacheIntegrity",
          parent: "cacheGroup",
          label: "cache integrity",
          sub: "stamp: model, backend, dtype, dim",
        },
        {
          id: "chunkSplitter",
          parent: "chunking",
          label: "chunk splitter",
          sub: "embed-chunk.mjs",
        },
      ],
    },
  },
  {
    kind: "org-chart",
    name: "surface-ownership",
    caption: "Who owns each engine surface, and the exact command or trigger that invokes it.",
    spec: {
      kind: "org-chart",
      id: "gx-owners",
      title: "Surface ownership and invocation",
      nodes: [
        { id: "maintainer", label: "engine maintainer", sub: "invoke: cli.mjs <command>" },
        {
          id: "captureOwner",
          parent: "maintainer",
          label: "capture owner",
          sub: "trigger: PostToolUse / SessionEnd",
        },
        {
          id: "compileOwner",
          parent: "maintainer",
          label: "compile owner",
          sub: "trigger: cli.mjs compile",
        },
        {
          id: "recallOwner",
          parent: "maintainer",
          label: "recall owner",
          sub: "trigger: MCP recall_lessons",
        },
        {
          id: "flushWorker",
          parent: "captureOwner",
          label: "flush worker",
          sub: "scripts/hooks/session-end.sh",
        },
        {
          id: "distillPass",
          parent: "captureOwner",
          label: "distill pass",
          sub: "LLM smol model, map-reduce",
        },
        {
          id: "judgeGate",
          parent: "compileOwner",
          label: "judge gate",
          sub: "cli.mjs compile --dry-run",
        },
        {
          id: "promoteStep",
          parent: "compileOwner",
          label: "promote step",
          sub: "writes knowledge/, self_improvement/",
        },
        {
          id: "mcpRouter",
          parent: "recallOwner",
          label: "MCP tool router",
          sub: "node mcp-server/index.mjs",
          kind: "focal",
        },
        {
          id: "chunkedSearch",
          parent: "recallOwner",
          label: "chunked search",
          sub: "search_memory tool",
        },
      ],
    },
  },
  {
    kind: "nested",
    name: "deployment-containment",
    caption:
      "What actually runs inside what: two OS processes on one workstation, each hosting its own components.",
    spec: {
      kind: "nested",
      id: "gx-deploy",
      title: "Engine deployment containment",
      root: {
        label: "developer workstation",
        sub: "macOS / Linux",
        children: [
          {
            label: "MCP server process",
            sub: "node mcp-server/index.mjs",
            children: [
              { label: "tool router", sub: "recall_lessons, save_lesson", kind: "focal" },
              { label: "embed backend", sub: "transformers.js" },
            ],
          },
          {
            label: "hourly cron process",
            sub: "cron-job.mjs",
            children: [
              { label: "compile stage", sub: "promote daily atoms" },
              { label: "consolidate stage", sub: "merge duplicate clusters" },
            ],
          },
        ],
      },
    },
  },
  {
    kind: "er",
    name: "wiki-data-model",
    caption:
      "The wiki's data model: leaves keyed by category, cached as embeddings, and split into recallable chunks.",
    spec: {
      kind: "er",
      id: "gx-wiki-model",
      title: "Wiki data model",
      entities: [
        {
          id: "category",
          label: "category",
          col: 0,
          row: 0,
          fields: [
            { name: "name", type: "string", key: "pk" },
            { name: "gated", type: "boolean" },
          ],
        },
        {
          id: "leaf",
          label: "leaf",
          col: 1,
          row: 0,
          kind: "focal",
          fields: [
            { name: "id", type: "string", key: "pk" },
            { name: "category", type: "string", key: "fk" },
            { name: "area", type: "string" },
            { name: "atom_type", type: "string" },
            { name: "content_hash", type: "string" },
            { name: "updated_at", type: "timestamp" },
          ],
        },
        {
          id: "cacheEntry",
          label: "embedding_cache_entry",
          col: 2,
          row: 0,
          kind: "store",
          fields: [
            { name: "leaf_id", type: "string", key: "fk" },
            { name: "content_hash", type: "string" },
            { name: "dim", type: "int" },
          ],
        },
        {
          id: "chunk",
          label: "chunk",
          col: 1,
          row: 1,
          fields: [
            { name: "leaf_id", type: "string", key: "fk" },
            { name: "chunk_index", type: "int", key: "pk" },
            { name: "text", type: "string" },
          ],
        },
      ],
      relations: [
        { from: "leaf", to: "category", label: "belongs to", cardinality: "N..1" },
        { from: "leaf", to: "cacheEntry", label: "cached as", cardinality: "1..1" },
        { from: "leaf", to: "chunk", label: "splits into", cardinality: "1..N" },
      ],
    },
  },
];
