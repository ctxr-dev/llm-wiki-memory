// subject-axis: a `kind: path` placement facet expands an array (broad->narrow)
// into nested directory segments, with a controlled-vocabulary first segment
// and a fallback sentinel. Covers placement, vocab enforcement, frontmatter
// persistence (so a relocated leaf recomputes the same path), and the layout
// validator's accept/reject of the new schema.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  placementDirForMeta,
  normaliseMeta,
  _resetLayoutCacheForTests,
} from "../scripts/lib/wiki-store.mjs";
import { validateLayoutFile } from "../scripts/lib/layout-validator.mjs";

const LAYOUT = `
vocabularies:
  subject_domains: [languages, observability, infra, general]
layout:
  - path: knowledge
    placement_facets: [area, atom_type, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
    max_depth: 8
  - path: self_improvement
    placement_facets: [area, task_type, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
    max_depth: 8
  - path: plans
    placement_facets: [area]
    max_depth: 5
  - path: daily
    placement_strategy: daily-date
    max_depth: 5
`;

function useLayout(yaml = LAYOUT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subj-wiki-"));
  fs.mkdirSync(path.join(root, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(root, ".layout", "layout.yaml"), yaml);
  process.env.LLM_WIKI_MEMORY_ROOT = root;
  _resetLayoutCacheForTests();
  return root;
}

function tmpLayoutFile(yaml) {
  const f = path.join(os.tmpdir(), `lv-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(f, yaml);
  return f;
}

afterEach(() => {
  delete process.env.LLM_WIKI_MEMORY_ROOT;
  _resetLayoutCacheForTests();
});

test("array subject expands broad->narrow into nested segments", () => {
  useLayout();
  assert.equal(
    placementDirForMeta("knowledge", {
      area: "scala-toolkit",
      atom_type: "concept",
      subject: ["observability", "kamon"],
    }),
    "knowledge/scala-toolkit/concept/observability/kamon",
  );
});

test("string subject ('a/b/c') is split into segments", () => {
  useLayout();
  assert.equal(
    placementDirForMeta("knowledge", {
      area: "scala-toolkit",
      atom_type: "concept",
      subject: "languages/scala/cats-effect",
    }),
    "knowledge/scala-toolkit/concept/languages/scala/cats-effect",
  );
});

test("absent subject collapses to the fallback sentinel", () => {
  useLayout();
  assert.equal(
    placementDirForMeta("knowledge", { area: "scala-toolkit", atom_type: "concept" }),
    "knowledge/scala-toolkit/concept/general",
  );
});

test("empty-array subject collapses to the fallback sentinel", () => {
  useLayout();
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept", subject: [] }),
    "knowledge/x/concept/general",
  );
});

test("subject segments are slugified (caps/spaces -> kebab)", () => {
  useLayout();
  assert.equal(
    placementDirForMeta("knowledge", {
      area: "x",
      atom_type: "concept",
      subject: ["Observability", "Kamon Metrics"],
    }),
    "knowledge/x/concept/observability/kamon-metrics",
  );
});

test("content-free subject segments are dropped (no 'untitled' leak)", () => {
  useLayout();
  // empty / whitespace / punctuation-only segments must NOT become 'untitled'.
  assert.equal(
    placementDirForMeta("knowledge", {
      area: "x",
      atom_type: "concept",
      subject: ["", "  ", "!!!", "observability", "kamon"],
    }),
    "knowledge/x/concept/observability/kamon",
  );
});

test("a subject of only content-free segments collapses to the fallback", () => {
  useLayout();
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept", subject: ["", "  ", "@@@"] }),
    "knowledge/x/concept/general",
  );
});

test("a segment whose content literally slugs to 'untitled' is kept", () => {
  useLayout(`
vocabularies:
  subject_domains: [general, untitled]
layout:
  - path: knowledge
    placement_facets: [area, atom_type, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
`);
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept", subject: ["untitled", "edge"] }),
    "knowledge/x/concept/untitled/edge",
  );
});

test("normaliseMeta drops content-free subject segments", () => {
  const m = normaliseMeta({ subject: ["", "  ", "Kamon", "!!!"] });
  assert.deepEqual(m.subject, ["kamon"]);
  const empty = normaliseMeta({ subject: ["", "   "] });
  assert.ok(!("subject" in empty), "all-empty subject is omitted");
});

test("invalid first domain throws (FAIL LOUD, no garbage path)", () => {
  useLayout();
  assert.throws(
    () =>
      placementDirForMeta("knowledge", {
        area: "x",
        atom_type: "concept",
        subject: ["bogus", "kamon"],
      }),
    /domain 'bogus' is not in vocabulary 'subject_domains'/,
  );
});

test("self_improvement also gets the subject axis", () => {
  useLayout();
  assert.equal(
    placementDirForMeta("self_improvement", {
      area: "meta",
      task_type: "process",
      subject: ["observability", "logging"],
    }),
    "self_improvement/meta/process/observability/logging",
  );
});

test("a facet WITHOUT a path rule stays single-segment (backward compat)", () => {
  useLayout();
  // plans has no subject facet; unchanged behaviour.
  assert.equal(placementDirForMeta("plans", { area: "webhooks" }), "plans/webhooks");
});

test("a kind:path facet with NO vocabulary accepts any first segment (free-form)", () => {
  useLayout(`
layout:
  - path: knowledge
    placement_facets: [area, atom_type, subject]
    facet_rules:
      subject: { kind: path, fallback: general }
    max_depth: 8
`);
  // No vocabulary declared -> any first segment is allowed (no throw).
  assert.equal(
    placementDirForMeta("knowledge", {
      area: "x",
      atom_type: "concept",
      subject: ["anything-goes", "deeper"],
    }),
    "knowledge/x/concept/anything-goes/deeper",
  );
});

test("vocabulary members are slugified, so a cased subject domain still matches", () => {
  useLayout(`
vocabularies:
  subject_domains: ["Observability", "General"]
layout:
  - path: knowledge
    placement_facets: [area, atom_type, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: General }
    max_depth: 8
`);
  // "Observability" (cased in both vocab and input) is slugified to
  // "observability" on both sides and matches without throwing.
  assert.equal(
    placementDirForMeta("knowledge", {
      area: "x",
      atom_type: "concept",
      subject: ["Observability", "Kamon"],
    }),
    "knowledge/x/concept/observability/kamon",
  );
  // absent -> the (cased) fallback, also slugified.
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x/concept/general",
  );
});

test("normaliseMeta persists subject as a slug array", () => {
  const m = normaliseMeta({ area: "x", atom_type: "concept", subject: ["Observability", "Kamon"] });
  assert.deepEqual(m.subject, ["observability", "kamon"]);
});

test("normaliseMeta accepts a '/'-joined subject string", () => {
  const m = normaliseMeta({ subject: "languages/scala/cats-effect" });
  assert.deepEqual(m.subject, ["languages", "scala", "cats-effect"]);
});

test("normaliseMeta omits subject when absent (placement applies fallback)", () => {
  const m = normaliseMeta({ area: "x", atom_type: "concept" });
  assert.ok(!("subject" in m), "subject must be omitted when not provided");
});

test("frontmatter subject round-trips: stored array recomputes the same path", () => {
  useLayout();
  const meta = normaliseMeta({ area: "scala-toolkit", atom_type: "concept", subject: ["observability", "kamon"] });
  // placementDirForMeta reads the persisted (normalised) frontmatter back.
  assert.equal(
    placementDirForMeta("knowledge", meta),
    "knowledge/scala-toolkit/concept/observability/kamon",
  );
});

test("layout with ignore_max_depth and NO max_depth validates + places a deep subject", () => {
  useLayout(`
ignore_max_depth: true
vocabularies:
  subject_domains: [languages, general]
layout:
  - path: knowledge
    placement_facets: [area, atom_type, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
`);
  // No max_depth anywhere; a deep subject places without error.
  assert.equal(
    placementDirForMeta("knowledge", {
      area: "scala-toolkit",
      atom_type: "concept",
      subject: ["languages", "scala", "cats-effect", "resource", "lifecycle"],
    }),
    "knowledge/scala-toolkit/concept/languages/scala/cats-effect/resource/lifecycle",
  );
});

test("validator accepts ignore_max_depth and a layout with no max_depth", () => {
  const f = tmpLayoutFile(`
ignore_max_depth: true
vocabularies:
  subject_domains: [general]
layout:
  - path: knowledge
    placement_facets: [area, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
`);
  assert.equal(validateLayoutFile(f).ok, true);
});

test("validator rejects a non-boolean ignore_max_depth", () => {
  const f = tmpLayoutFile(`
ignore_max_depth: "yes"
layout:
  - path: knowledge
    placement_facets: [area]
`);
  assert.equal(validateLayoutFile(f).ok, false);
});

// --- layout validator ---

test("validator accepts a well-formed subject layout", () => {
  const f = tmpLayoutFile(LAYOUT);
  assert.equal(validateLayoutFile(f).ok, true);
});

test("validator rejects a facet_rule referencing an undeclared vocabulary", () => {
  const f = tmpLayoutFile(`
layout:
  - path: knowledge
    placement_facets: [area, subject]
    facet_rules:
      subject: { kind: path, vocabulary: nope }
`);
  const r = validateLayoutFile(f);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /vocabulary 'nope' which is not declared/);
});

test("validator rejects a fallback that isn't a vocabulary member", () => {
  const f = tmpLayoutFile(`
vocabularies:
  subject_domains: [languages, observability]
layout:
  - path: knowledge
    placement_facets: [area, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: zzz }
`);
  const r = validateLayoutFile(f);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /fallback 'zzz' is not a member/);
});

test("validator rejects a facet_rule for a facet not in placement_facets", () => {
  const f = tmpLayoutFile(`
vocabularies:
  subject_domains: [general]
layout:
  - path: knowledge
    placement_facets: [area]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
`);
  const r = validateLayoutFile(f);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /not listed in placement_facets/);
});
