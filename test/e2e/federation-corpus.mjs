/**
 * @typedef {"knowledge"|"self_improvement"|"plans"|"investigations"|"issues"|"team"|"runbooks"} Category
 * @typedef {{ atom_type?: string, area?: string, task_type?: string, error_pattern?: string, language?: string, subject?: string[] }} DocMeta
 * @typedef {{ tracker: string, prefix: string, number: number, lifecycle?: string, slug?: string }} TopologyFacets
 * @typedef {{ id: string, datasetId: Category, metadata: DocMeta, topology?: TopologyFacets, token: string, edge: string }} MockDoc
 * @typedef {"DEF"|"REPO"|"TRK"} LayoutKind
 * @typedef {string | { throws: RegExp } | { absentCategory: true }} PlacementOutcome
 */

/** @type {Record<string, MockDoc>} */
export const MOCK_DOCS = {
  K1: {
    id: "K1",
    datasetId: "knowledge",
    metadata: { atom_type: "pattern-gotcha", area: "billing", subject: ["observability", "kamon"] },
    token: "gaugesampler",
    edge: "baseline-nested",
  },
  K2: {
    id: "K2",
    datasetId: "knowledge",
    metadata: {
      atom_type: "reference",
      area: "infra",
      subject: ["languages", "scala", "cats-effect"],
    },
    token: "catseffectio",
    edge: "multi-segment-subject",
  },
  K3: {
    id: "K3",
    datasetId: "knowledge",
    metadata: { atom_type: "reference" },
    token: "orphanfact",
    edge: "sentinels",
  },
  K4: {
    id: "K4",
    datasetId: "knowledge",
    metadata: {
      atom_type: "reference",
      area: "billing",
      subject: ["quantumphysics", "entanglement"],
    },
    token: "entangled",
    edge: "out-of-vocab-subject",
  },
  S1: {
    id: "S1",
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "billing",
      task_type: "debugging",
      error_pattern: "npe-on-null",
      subject: ["data", "postgres"],
    },
    token: "nullpointer",
    edge: "lesson-nested-gated",
  },
  S2: {
    id: "S2",
    datasetId: "self_improvement",
    metadata: { atom_type: "self-improvement-lesson", area: "billing", error_pattern: "x" },
    token: "notasktype",
    edge: "task-type-sentinel",
  },
  P1: {
    id: "P1",
    datasetId: "plans",
    metadata: { atom_type: "plan", area: "infra", subject: ["architecture", "refactoring"] },
    token: "refactorplan",
    edge: "plans-nested",
  },
  I1: {
    id: "I1",
    datasetId: "investigations",
    metadata: { atom_type: "investigation", area: "infra" },
    token: "forensictrace",
    edge: "subject-fallback",
  },
  T1: {
    id: "T1",
    datasetId: "issues",
    metadata: { atom_type: "reference" },
    topology: { tracker: "JIRA", prefix: "DEV", number: 129957 },
    token: "trackerfact",
    edge: "topology-knowledge",
  },
  T2: {
    id: "T2",
    datasetId: "issues",
    metadata: { atom_type: "plan" },
    topology: {
      tracker: "JIRA",
      prefix: "DEV",
      number: 42,
      lifecycle: "in-progress",
      slug: "fix-retry",
    },
    token: "trackerplan",
    edge: "topology-plan",
  },
  G1: {
    id: "G1",
    datasetId: "team",
    metadata: { atom_type: "reference" },
    token: "teamnote",
    edge: "category-present-some-levels",
  },
  L1: {
    id: "L1",
    datasetId: "runbooks",
    metadata: { atom_type: "reference" },
    token: "runbooknote",
    edge: "local-added-category",
  },
};

const OUT_OF_VOCAB = { throws: /not in vocabulary/ };
const ABSENT = { absentCategory: true };

/** @type {Record<string, Record<LayoutKind, PlacementOutcome>>} */
export const EXPECTED_PLACEMENT = {
  K1: {
    DEF: "knowledge/billing/pattern-gotcha/observability/kamon",
    REPO: "knowledge/observability/kamon/pattern-gotcha",
    TRK: "knowledge/billing/pattern-gotcha/observability/kamon",
  },
  K2: {
    DEF: "knowledge/infra/reference/languages/scala/cats-effect",
    REPO: "knowledge/languages/scala/cats-effect/reference",
    TRK: "knowledge/infra/reference/languages/scala/cats-effect",
  },
  K3: {
    DEF: "knowledge/unscoped/reference/general",
    REPO: "knowledge/general/reference",
    TRK: "knowledge/unscoped/reference/general",
  },
  K4: { DEF: OUT_OF_VOCAB, REPO: OUT_OF_VOCAB, TRK: OUT_OF_VOCAB },
  S1: {
    DEF: "self_improvement/billing/debugging/data/postgres",
    REPO: ABSENT,
    TRK: "self_improvement/billing/debugging/data/postgres",
  },
  S2: {
    DEF: "self_improvement/billing/unknown/general",
    REPO: ABSENT,
    TRK: "self_improvement/billing/unknown/general",
  },
  P1: {
    DEF: "plans/infra/architecture/refactoring",
    REPO: ABSENT,
    TRK: "plans/infra/architecture/refactoring",
  },
  I1: { DEF: "investigations/infra/general", REPO: ABSENT, TRK: "investigations/infra/general" },
};

/** @type {Record<string, string>} */
export const EXPECTED_TOPOLOGY_PATH = {
  T1: "issues/JIRA/DEV/129/95/7/DEV-129957.md",
  T2: "issues/JIRA/DEV/0/4/2/in-progress/DEV-42-fix-retry.plan.md",
};

/**
 * @param {MockDoc} doc
 * @returns {string} deterministic one-line body carrying the doc's unique token
 */
export function bodyFor(doc) {
  return `# ${doc.id}\n\nquokka ${doc.token} marker for ${doc.id}.`;
}

/**
 * @param {PlacementOutcome} outcome
 * @returns {boolean}
 */
export function isThrow(outcome) {
  return typeof outcome === "object" && outcome !== null && "throws" in outcome;
}

/**
 * @param {PlacementOutcome} outcome
 * @returns {boolean}
 */
export function isAbsentCategory(outcome) {
  return typeof outcome === "object" && outcome !== null && "absentCategory" in outcome;
}
