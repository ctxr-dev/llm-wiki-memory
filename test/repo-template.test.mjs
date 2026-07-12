// The `repo` layout template: validates, and its subject-FIRST placement
// (knowledge/<subject…>/<atom_type>) round-trips over a variable-depth subject.
// A repo mount is knowledge-only and consolidate-excluded.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withWikiRoot } from "../scripts/lib/env.mjs";
import { _resetLayoutCacheForTests, vocabularyFor } from "../scripts/lib/wiki-layout-state.mjs";
import { placementDirForMeta } from "../scripts/lib/wiki-store.mjs";
import { validateLayoutFile } from "../scripts/lib/layout-validator.mjs";
import { installLayoutTemplate } from "../scripts/lib/layout-template.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");

/** @type {string[]} */
const tmps = [];
function tmpWiki() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-repo-tmpl-")));
  tmps.push(d);
  const wiki = path.join(d, "wiki");
  installLayoutTemplate(path.join(wiki, ".layout"), "repo");
  return wiki;
}
after(() => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("repo template passes validate_layout", () => {
  const r = validateLayoutFile(path.join(SRC, "examples/layouts/repo/layout.yaml"));
  assert.equal(r.ok, true, JSON.stringify(r, null, 2));
});

test("repo template nests subject-FIRST then atom_type (forward)", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    assert.equal(
      placementDirForMeta("knowledge", {
        subject: ["frameworks", "react"],
        atom_type: "pattern-gotcha",
      }),
      "knowledge/frameworks/react/pattern-gotcha",
    );
  });
});

test("repo template path round-trips over a VARIABLE-DEPTH subject (forward + reverse)", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    /** @type {[string[], string, string][]} */
    const cases = [
      [["frameworks", "react"], "pattern-gotcha", "knowledge/frameworks/react/pattern-gotcha"],
      [
        ["languages", "scala", "cats-effect"],
        "reference",
        "knowledge/languages/scala/cats-effect/reference",
      ],
      [["frameworks"], "decision", "knowledge/frameworks/decision"],
    ];
    for (const [subject, atomType, expected] of cases) {
      const dir = placementDirForMeta("knowledge", { subject, atom_type: atomType });
      assert.equal(dir, expected, `forward: ${JSON.stringify(subject)}`);
      // Reverse: category | subject… (variable) | atom_type (single last segment).
      const segs = dir.split("/");
      const recoveredAtom = segs[segs.length - 1];
      const recoveredSubject = segs.slice(1, -1);
      assert.deepEqual(recoveredSubject, subject, "subject recovered");
      assert.equal(recoveredAtom, atomType, "atom_type recovered");
      // Re-forward the recovered facets: an invertible compiler yields the same path.
      assert.equal(
        placementDirForMeta("knowledge", { subject: recoveredSubject, atom_type: recoveredAtom }),
        dir,
        "round-trip stable",
      );
      // The recovered first segment is a declared subject domain.
      const vocab = vocabularyFor("subject_domains");
      assert.ok(vocab && vocab.has(recoveredSubject[0]), "first segment in vocabulary");
    }
  });
});

test("repo template: absent subject collapses to the `general` fallback (still invertible)", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    const dir = placementDirForMeta("knowledge", { atom_type: "reference" });
    assert.equal(dir, "knowledge/general/reference");
    const segs = dir.split("/");
    assert.deepEqual(segs.slice(1, -1), ["general"]);
  });
});

test("repo template: an out-of-vocabulary first subject segment FAILS LOUD", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    assert.throws(
      () =>
        placementDirForMeta("knowledge", { subject: ["notadomain", "x"], atom_type: "reference" }),
      /vocabulary/,
      "deep placement with no valid domain must throw",
    );
  });
});
