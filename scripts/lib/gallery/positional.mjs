/**
 * Gallery examples for the positional diagram kinds: quadrant, wardley,
 * timeline, loop, fishbone, layers, kanban, medallion, and high-level. Every
 * example is drawn from one domain, this repo's own memory engine, so the
 * gallery reads as a coherent tour: capture hooks feed daily atoms, a
 * compile step promotes them into knowledge, an MCP server exposes recall
 * tools, and an hourly cron keeps the corpus consolidated.
 */

/** @type {{kind: string, name: string, caption: string, spec: any}[]} */
export const positionalExamples = [
  {
    kind: "quadrant",
    name: "quadrant-effort-impact-roadmap",
    caption:
      "Eight roadmap items scored by effort and impact, with cross-repo consolidation as the single flagship bet.",
    spec: {
      kind: "quadrant",
      id: "gx-positional-quadrant",
      title: "Engine roadmap: effort vs impact",
      xAxis: { label: "effort", low: "low", high: "high" },
      yAxis: { label: "impact", low: "low", high: "high" },
      quadrants: ["quick wins", "flagship bets", "later", "reconsider"],
      items: [
        { label: "warm cache preflight", x: 0.18, y: 0.85 },
        { label: "dedupe near-duplicates", x: 0.32, y: 0.68 },
        { label: "cross-repo consolidation", x: 0.78, y: 0.82, focal: true },
        { label: "llm-scored compile judge", x: 0.6, y: 0.66 },
        { label: "colorize doctor output", x: 0.16, y: 0.22 },
        { label: "rename cron-job flags", x: 0.3, y: 0.12 },
        { label: "full-text search fallback", x: 0.82, y: 0.28 },
        { label: "multi-tenant wiki shards", x: 0.66, y: 0.14 },
      ],
    },
  },
  {
    kind: "wardley",
    name: "wardley-memory-engine-value-chain",
    caption:
      "The memory engine's value chain from a developer's question down to the commodity embedding model it depends on.",
    spec: {
      kind: "wardley",
      id: "gx-positional-wardley",
      title: "Memory engine value chain",
      components: [
        { id: "question", label: "developer asks in chat", visibility: 0.95, evolution: 0.55 },
        {
          id: "recall-tool",
          label: "recall_lessons mcp tool",
          visibility: 0.8,
          evolution: 0.4,
          focal: true,
        },
        { id: "mcp-server", label: "mcp server process", visibility: 0.62, evolution: 0.45 },
        { id: "search", label: "chunked semantic search", visibility: 0.5, evolution: 0.55 },
        { id: "wiki", label: "git-backed wiki leaves", visibility: 0.35, evolution: 0.68 },
        { id: "cache", label: "embedding cache", visibility: 0.22, evolution: 0.78 },
        { id: "embed", label: "embeddinggemma-300m", visibility: 0.1, evolution: 0.9 },
      ],
      links: [
        { from: "question", to: "recall-tool" },
        { from: "recall-tool", to: "mcp-server" },
        { from: "mcp-server", to: "search" },
        { from: "search", to: "wiki" },
        { from: "search", to: "cache" },
        { from: "cache", to: "embed" },
      ],
    },
  },
  {
    kind: "timeline",
    name: "timeline-release-history",
    caption:
      "Seven releases across the year, spaced by real elapsed time, with the local embedding swap as the turning point.",
    spec: {
      kind: "timeline",
      id: "gx-positional-timeline",
      title: "Release history",
      events: [
        { date: "2026-01", label: "captured hooks ship", sub: "PostToolUse writes daily atoms" },
        { date: "2026-02", label: "compile step lands", sub: "atoms promoted to knowledge" },
        {
          date: "2026-03",
          label: "embeddinggemma adopted",
          sub: "local embed backend swap",
          focal: true,
        },
        { date: "2026-05", label: "mcp server ships", sub: "recall_lessons tool exposed" },
        { date: "2026-07", label: "consolidation pass", sub: "autodream-style dedup" },
        { date: "2026-08", label: "gallery viewer", sub: "diagram catalogue browsable" },
        { date: "2026-10", label: "v2 planning", sub: "federation across repos" },
      ],
    },
  },
  {
    kind: "loop",
    name: "loop-memory-flywheel",
    caption:
      "The memory flywheel: capture feeds distillation, distillation feeds compile, and compile feeds the next recall.",
    spec: {
      kind: "loop",
      id: "gx-positional-loop",
      title: "Memory flywheel",
      stages: [
        { label: "capture", sub: "hooks flush daily atoms" },
        { label: "distil", sub: "raw signal to atomic notes" },
        { label: "compile", sub: "atoms promoted to knowledge", focal: true },
        { label: "recall", sub: "chunked search via mcp" },
      ],
    },
  },
  {
    kind: "fishbone",
    name: "fishbone-recall-returned-nothing",
    caption:
      "Four root-cause categories for an empty recall, with an empty corpus as the most common culprit.",
    spec: {
      kind: "fishbone",
      id: "gx-positional-fishbone",
      title: "Why recall returned nothing",
      effect: "recall returned nothing",
      categories: [
        {
          label: "embedding",
          causes: ["stale embeddings cache", "backend/dim mismatch", "lexical fallback used"],
        },
        {
          label: "query",
          causes: ["wrong scopes passed", "over-narrow filters", "typoed area facet"],
        },
        {
          label: "corpus",
          causes: ["category is empty", "leaves all disabled", "wrong data dir"],
          focal: true,
        },
        {
          label: "config",
          causes: ["embed.backend wrong", "missing model path", "stale layout cache"],
        },
      ],
    },
  },
  {
    kind: "layers",
    name: "layers-recall-stack",
    caption:
      "The recall stack from git-backed wiki leaves up to the MCP tool surface an agent actually calls.",
    spec: {
      kind: "layers",
      id: "gx-positional-layers",
      title: "Recall stack: wiki leaves to MCP tools",
      direction: { label: "abstraction", up: true },
      layers: [
        { name: "mcp tool surface", tag: "L5", note: "recall_lessons + search_memory" },
        { name: "scope resolver", tag: "L4", note: "cwd + git root -> scopes[]" },
        {
          name: "chunked semantic search",
          tag: "L3",
          note: "cosine rank over chunks",
          focal: true,
        },
        { name: "embedding cache", tag: "L2", note: "embeddings.json per category" },
        { name: "embed backend", tag: "L1", note: "embeddinggemma-300m" },
        { name: "git-backed wiki leaves", tag: "L0", note: "markdown + frontmatter" },
      ],
    },
  },
  {
    kind: "kanban",
    name: "kanban-diagram-engine-board",
    caption:
      "The diagram engine's own work board: a wide backlog, a WIP-limited pass in progress, an empty review lane, and settled work.",
    spec: {
      kind: "kanban",
      id: "gx-positional-kanban",
      title: "Diagram engine board",
      columns: [
        {
          id: "backlog",
          label: "Backlog",
          cards: [
            {
              label:
                "Add sankey 3-layer flow presets to the gallery module for a convincing example",
              sub: "needs: domain review",
            },
            { label: "Support radial dendrogram kind" },
            { label: "next quarter's diagram kind", kind: "ghost" },
          ],
        },
        {
          id: "in-progress",
          label: "In Progress",
          wip: 3,
          cards: [
            {
              label: "Write gallery specs for 29 kinds",
              sub: "3 parallel agents",
              kind: "focal",
            },
            { label: "Wire diagrams-examples.md generator" },
          ],
        },
        { id: "review", label: "Review", cards: [] },
        {
          id: "shipped",
          label: "Shipped",
          cards: [
            { label: "validateSvg geometric self-check", kind: "store" },
            { label: "registerRenderer catalogue + docs test", kind: "store" },
            { label: "loop, fishbone, wardley renderers", kind: "store" },
            { label: "medallion, high-level renderers", kind: "store" },
          ],
        },
      ],
    },
  },
  {
    kind: "medallion",
    name: "medallion-captured-corpus-tiers",
    caption:
      "Five tiers of the captured corpus, from a hook's raw daily atom to a garbage-collected cold archive.",
    spec: {
      kind: "medallion",
      id: "gx-positional-medallion",
      title: "Captured corpus data tiers",
      tiers: [
        {
          label: "Daily",
          holds: "raw daily atoms",
          writer: "capture hook",
          tool: "PostToolUse -> flush",
          format: "markdown + frontmatter",
        },
        {
          label: "Distilled",
          holds: "distilled atoms",
          writer: "distill worker",
          tool: "cli.mjs redistill",
          format: "atomic note + metadata",
        },
        {
          label: "Knowledge",
          holds: "promoted knowledge",
          writer: "compile step",
          tool: "cli.mjs cron-job compile",
          format: "knowledge leaf + atom_type",
          focal: true,
        },
        {
          label: "Aggregated",
          holds: "aggregated stats",
          writer: "consolidate pass",
          tool: "consolidate_memory mcp",
          format: "cluster summary json",
        },
        {
          label: "Archive",
          holds: "cold archive",
          writer: "gc sweep",
          tool: "embed-gc sweep",
          format: "archived leaf, no recall",
        },
      ],
    },
  },
  {
    kind: "high-level",
    name: "highlevel-platform-end-to-end",
    caption:
      "The platform end to end: hooks capture, git stores, chunked search recalls, and the MCP server serves it back to the agent.",
    spec: {
      kind: "high-level",
      id: "gx-positional-highlevel",
      title: "Memory engine platform overview",
      chevrons: ["capture", "store", "recall", "serve"],
      components: [
        { label: "PostToolUse hook", phase: 0 },
        { label: "SessionEnd hook", phase: 0 },
        { label: "git-backed wiki", phase: 1 },
        { label: "embeddings.json cache", phase: 1 },
        { label: "chunked semantic search", phase: 2, focal: true },
        { label: "mcp server", phase: 3 },
        { label: "gallery web viewer", phase: 3 },
      ],
      orchestration: "cron-job.mjs (hourly)",
      identity: "scopes[] + project identity",
    },
  },
];
