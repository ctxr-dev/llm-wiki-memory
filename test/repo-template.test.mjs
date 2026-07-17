// The `repo` layout template: a SHARED, FULL-doc team wiki. Validates; its
// subject-ONLY placement (knowledge/<domain>/<subtopic>) round-trips over a
// variable-depth subject; the knowledge category is FULL (whole-doc, embedded
// whole); it is knowledge-only and consolidate-excluded.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withWikiRoot } from "../scripts/lib/env.mjs";
import {
  _resetLayoutCacheForTests,
  vocabularyFor,
  isFullCategory,
} from "../scripts/lib/wiki-layout-state.mjs";
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

test("repo template: the knowledge category is FULL (whole-doc, embedded whole)", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    assert.equal(isFullCategory("knowledge"), true);
  });
});

test("repo template nests subject-ONLY: <domain>/<subtopic> (atom_type does NOT shape the path)", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    assert.equal(
      placementDirForMeta("knowledge", {
        subject: ["architecture", "payments"],
        atom_type: "reference",
      }),
      "knowledge/architecture/payments",
      "atom_type is ignored for placement (frontmatter only)",
    );
  });
});

test("repo template path round-trips over a variable-depth subject (forward + reverse)", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    /** @type {[string[], string][]} */
    const cases = [
      [["architecture", "payments"], "knowledge/architecture/payments"],
      [["operations"], "knowledge/operations"],
      [["data", "warehouse"], "knowledge/data/warehouse"],
    ];
    for (const [subject, expected] of cases) {
      const dir = placementDirForMeta("knowledge", { subject });
      assert.equal(dir, expected, `forward: ${JSON.stringify(subject)}`);
      // Reverse: every segment after the category IS subject (no atom_type folder).
      const recoveredSubject = dir.split("/").slice(1);
      assert.deepEqual(recoveredSubject, subject, "subject recovered");
      assert.equal(
        placementDirForMeta("knowledge", { subject: recoveredSubject }),
        dir,
        "round-trip stable",
      );
      const vocab = vocabularyFor("subject_domains");
      assert.ok(vocab && vocab.has(recoveredSubject[0]), "first segment in vocabulary");
    }
  });
});

test("repo template: absent subject collapses to the `general` fallback", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    assert.equal(placementDirForMeta("knowledge", { atom_type: "reference" }), "knowledge/general");
  });
});

test("repo template: an out-of-vocabulary first subject segment FAILS LOUD", () => {
  const wiki = tmpWiki();
  withWikiRoot(wiki, () => {
    _resetLayoutCacheForTests();
    assert.throws(
      () => placementDirForMeta("knowledge", { subject: ["notadomain", "x"] }),
      /vocabulary/,
      "deep placement with no valid domain must throw",
    );
  });
});
