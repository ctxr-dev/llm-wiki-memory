import { test } from "node:test";
import assert from "node:assert/strict";
import { knownKinds, draw } from "../scripts/lib/diagrams/index.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { allExamples } from "../scripts/lib/gallery/index.mjs";

// The gallery is the page users read to decide which diagram type they want, so
// a kind missing from it is a kind nobody discovers. This is the gate that makes
// "every type is shown" true by construction rather than by memory.

test("every registered diagram kind has a gallery example", () => {
  const shown = new Set(allExamples().map((e) => e.kind));
  const missing = knownKinds().filter((k) => !shown.has(k));
  assert.deepEqual(
    missing,
    [],
    `these kinds render but appear nowhere in docs/diagrams-examples.md: ${missing.join(", ")}. ` +
      `Add one to scripts/lib/gallery/ and re-run npm run docs:gallery.`,
  );
});

test("the gallery shows no kind the engine cannot render", () => {
  const kinds = new Set(knownKinds());
  for (const e of allExamples()) {
    assert.ok(kinds.has(e.kind), `gallery entry ${e.name} names unknown kind ${e.kind}`);
  }
});

test("gallery slugs are unique, url-safe, and usable as filenames", () => {
  // Each slug is simultaneously an HTML anchor, a markdown link target and a PNG
  // filename, so anything outside this alphabet breaks at least one of the three.
  const seen = new Set();
  for (const e of allExamples()) {
    assert.match(e.name, /^[a-z0-9][a-z0-9-]*$/, `slug ${e.name} is not url/file safe`);
    assert.ok(!seen.has(e.name), `duplicate slug ${e.name}`);
    seen.add(e.name);
  }
});

test("every gallery spec dispatches to the kind it claims", () => {
  // Regression: `draw` dispatches on `spec.kind ?? "flow"`, so a spec object that
  // omits its own `kind` silently renders as a malformed FLOW diagram while the
  // gallery entry still advertises it as something else. Six examples shipped
  // that way before this was caught.
  for (const e of allExamples()) {
    const declared = e.spec.kind ?? "flow";
    assert.equal(
      declared,
      e.kind,
      `gallery entry ${e.name} is listed as ${e.kind} but its spec dispatches to ${declared}`,
    );
  }
});

test("every gallery example renders with zero geometric findings", () => {
  // These are the diagrams the project shows off with. A defect here is a defect
  // on the landing page.
  for (const e of allExamples()) {
    const findings = validateSvg(draw(e.spec));
    assert.deepEqual(findings, [], `${e.name} (${e.kind}): ${JSON.stringify(findings)}`);
  }
});

test("every gallery example carries a short, useful caption", () => {
  for (const e of allExamples()) {
    assert.ok(e.caption.trim().length > 10, `${e.name} has no usable caption`);
    assert.ok(e.caption.length < 140, `${e.name} caption is too long to scan`);
  }
});
