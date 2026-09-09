// Chart-type gallery specs, all drawn from one running system: the memory
// engine's own capture -> distill -> compile -> recall pipeline. One domain
// end to end so the gallery reads as a tour, not a grab bag of unrelated data.

/** @type {{ kind: string, name: string, caption: string, spec: any }[]} */
export const chartsExamples = [
  {
    kind: "bar",
    name: "leaves-by-category",
    caption:
      "Knowledge leaves dominate the 90-day promotion count, with a long tail across the other six categories.",
    spec: {
      kind: "bar",
      id: "gc-bar-leaves-by-category",
      title: "Leaves promoted per wiki category, last 90 days",
      xLabel: "Wiki category",
      yLabel: "Leaves promoted",
      bars: [
        { label: "knowledge", value: 486, focal: true },
        { label: "daily", value: 214 },
        { label: "investigations", value: 88 },
        { label: "plans", value: 37 },
        { label: "self_improvement", value: 21 },
        { label: "issues", value: 9 },
        { label: "state", value: 3 },
      ],
    },
  },
  {
    kind: "line",
    name: "recall-latency-percentiles",
    caption:
      "The p99 recall tail spikes during a week-5 lexical-fallback incident and recovers once the guard fix lands.",
    spec: {
      kind: "line",
      id: "gc-line-recall-latency",
      title: "MCP recall latency by percentile",
      xLabel: "Week",
      yLabel: "Latency (ms)",
      xLabels: ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"],
      series: [
        { label: "p10", values: [34, 36, 33, 35, 38, 37, 34, 33, 35, 34] },
        { label: "p50", values: [88, 92, 85, 90, 101, 110, 95, 89, 86, 88] },
        {
          label: "p99",
          values: [240, 260, 230, 270, 520, 610, 340, 260, 235, 225],
          focal: true,
          area: true,
        },
      ],
    },
  },
  {
    kind: "scatter",
    name: "embed-cost-vs-accuracy",
    caption:
      "Bigger embedding models buy accuracy at a steep cost premium; the shipped default sits near the elbow of that curve.",
    spec: {
      kind: "scatter",
      id: "gc-scatter-embed-cost-accuracy",
      title: "Embedding cost vs recall accuracy by model config",
      xLabel: "Embed cost (ms/doc)",
      yLabel: "Recall@10 accuracy (%)",
      points: [
        { x: 3, y: 61, label: "lexical" },
        { x: 6, y: 68 },
        { x: 7, y: 71 },
        { x: 9, y: 74 },
        { x: 12, y: 76 },
        { x: 15, y: 79 },
        { x: 18, y: 78 },
        { x: 22, y: 86, label: "gemma-300m-q4", focal: true },
        { x: 29, y: 85, label: "bge-large-q8" },
        { x: 34, y: 87 },
        { x: 61, y: 88 },
        { x: 68, y: 89 },
        { x: 74, y: 89 },
      ],
      trend: true,
      quadrants: true,
    },
  },
  {
    kind: "gantt",
    name: "engine-build-phases",
    caption:
      "The embed-cache guard rewrite is the critical middle block between baseline profiling and the consolidate rollout.",
    spec: {
      kind: "gantt",
      id: "gc-gantt-build-phases",
      title: "Embed-cache guard hardening, build to rollout",
      scale: { start: 0, end: 14, unit: "day" },
      tasks: [
        { label: "profile cold-embed baseline", start: 0, end: 2, lane: "core" },
        { label: "rewrite embed-cache guards", start: 2, end: 6, lane: "core", focal: true },
        { label: "guard merged to main", start: 6, end: 6, lane: "core", milestone: true },
        { label: "wire search-driven clustering", start: 6, end: 9, lane: "consolidate" },
        { label: "add stale-refresh LLM pass", start: 9, end: 11, lane: "consolidate" },
        { label: "write update-prompt runbook", start: 11, end: 12, lane: "release" },
        { label: "re-warm every shared wiki", start: 12, end: 13, lane: "release" },
        { label: "retro", start: 13, end: 14, lane: "release" },
      ],
    },
  },
  {
    kind: "radar",
    name: "embed-backend-scorecard",
    caption:
      "Lexical wins on speed, memory and cost; transformers wins only on accuracy, which keeps it the shipped default.",
    spec: {
      kind: "radar",
      id: "gc-radar-embed-backends",
      title: "Embedding backend scorecard",
      axes: ["latency", "cost", "accuracy", "memory", "cold start", "offline"],
      series: [
        { label: "transformers (default)", values: [3, 2, 5, 2, 2, 4], focal: true },
        { label: "lexical (fallback)", values: [5, 5, 2, 5, 5, 5] },
      ],
      max: 5,
    },
  },
  {
    kind: "polar",
    name: "captures-by-hour",
    caption: "Captures track the working day, peaking mid-afternoon and nearly silent overnight.",
    spec: {
      kind: "polar",
      id: "gc-polar-captures-by-hour",
      title: "Session captures by hour of day",
      slices: [
        { label: "00:00", value: 4 },
        { label: "02:00", value: 2 },
        { label: "04:00", value: 1 },
        { label: "06:00", value: 5 },
        { label: "08:00", value: 23 },
        { label: "10:00", value: 41 },
        { label: "12:00", value: 38 },
        { label: "14:00", value: 47, focal: true },
        { label: "16:00", value: 33 },
        { label: "18:00", value: 19 },
        { label: "20:00", value: 9 },
        { label: "22:00", value: 6 },
      ],
      rLabel: "captures",
    },
  },
  {
    kind: "pyramid",
    name: "capture-funnel",
    caption:
      "Just a quarter of session turns get captured, and barely one in ten of those are ever recalled again.",
    spec: {
      kind: "pyramid",
      id: "gc-pyramid-capture-funnel",
      title: "Capture funnel: turns to durable recall",
      shape: "funnel",
      stages: [
        { label: "session turns", value: 8600 },
        { label: "captured", value: 2150 },
        { label: "distilled", value: 1780 },
        { label: "promoted", value: 640, focal: true },
        { label: "recalled", value: 210 },
      ],
    },
  },
  {
    kind: "treemap",
    name: "corpus-bytes-treemap",
    caption:
      "Knowledge dwarfs the other seven categories, though the gated self_improvement cell is the one worth watching.",
    spec: {
      kind: "treemap",
      id: "gc-treemap-corpus-bytes",
      title: "Wiki corpus size by category (KB)",
      cells: [
        { label: "knowledge", value: 5240 },
        { label: "daily", value: 1380 },
        { label: "investigations", value: 960 },
        { label: "plans", value: 210 },
        { label: "issues", value: 64 },
        { label: "self_improvement", value: 47, focal: true },
        { label: "state", value: 9 },
        { label: "cache", value: 2 },
      ],
    },
  },
  {
    kind: "venn",
    name: "leaf-lifecycle-venn",
    caption:
      "Most recalled leaves were not touched again this week; only a small core sits in all three sets.",
    spec: {
      kind: "venn",
      id: "gc-venn-leaf-lifecycle",
      title: "Leaf lifecycle overlap, this week",
      sets: [
        { label: "recalled this week", focal: true },
        { label: "saved this week" },
        { label: "consolidated this week" },
      ],
      regions: [
        { sets: [0], label: "96" },
        { sets: [1], label: "34" },
        { sets: [2], label: "11" },
        { sets: [0, 1], label: "22" },
        { sets: [0, 2], label: "9" },
        { sets: [1, 2], label: "5" },
        { sets: [0, 1, 2], label: "4" },
      ],
    },
  },
  {
    kind: "sankey",
    name: "capture-routing-sankey",
    caption:
      "Manual saves are a small but steady stream into the same captured pool that automatic turn-capture fills.",
    spec: {
      kind: "sankey",
      id: "gc-sankey-capture-routing",
      title: "Where captured volume goes",
      nodes: [
        { id: "session-turns", label: "session turns", layer: 0 },
        { id: "manual-saves", label: "manual saves", layer: 0 },
        { id: "captured", label: "captured", layer: 1 },
        { id: "stashed", label: "stashed", layer: 1 },
        { id: "promoted", label: "promoted", layer: 2 },
        { id: "archived", label: "archived", layer: 2 },
      ],
      flows: [
        { from: "session-turns", to: "captured", value: 3400 },
        { from: "session-turns", to: "stashed", value: 260 },
        { from: "manual-saves", to: "captured", value: 640, focal: true },
        { from: "manual-saves", to: "stashed", value: 40 },
        { from: "captured", to: "promoted", value: 4040 },
        { from: "stashed", to: "archived", value: 300 },
      ],
    },
  },
];
