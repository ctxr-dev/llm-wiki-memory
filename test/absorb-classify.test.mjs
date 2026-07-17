import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// classifyWithLLM only needs settings (for the provider) — the vocab is passed
// in as `subjectChoices`, so no wiki layout is required.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-classify-"));
process.env.MEMORY_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, "settings"), { recursive: true });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
});

const { classifyWithLLM } = await import("../scripts/lib/facets-classify-llm.mjs");

const SUBJECTS = ["architecture", "operations", "data", "general"];
function withMock(json, fn) {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify(json);
  return fn();
}
const base = {
  category: "docs",
  title: "Checkout design",
  text: "How the checkout service is structured.",
  tags: [],
  areaChoices: ["billing", "infra"],
  typeChoices: ["reference", "decision"],
  subjectChoices: SUBJECTS,
  want: { area: true, atom_type: true, subject: true },
};

test("classifyWithLLM: an in-vocab subject is slugified + kept (first segment ∈ vocab)", async () => {
  const out = await withMock(
    { area: "infra", atom_type: "reference", subject: ["Architecture", "Payments"] },
    () => classifyWithLLM(base),
  );
  assert.deepEqual(out.subject, ["architecture", "payments"], "kept, slugified, order preserved");
  assert.equal(out.area, "infra");
  assert.equal(out.atom_type, "reference");
});

test("classifyWithLLM: an OUT-of-vocab first segment is OMITTED (would throw in placement — C5)", async () => {
  const out = await withMock(
    { area: "infra", atom_type: "reference", subject: ["quantumphysics", "entanglement"] },
    () => classifyWithLLM(base),
  );
  assert.equal("subject" in out, false, "out-of-vocab subject dropped, not returned");
});

test("classifyWithLLM: a content-free subject sub-segment (empty OR punctuation-only) is dropped (no `untitled` folder)", async () => {
  const empty = await withMock(
    { area: "infra", atom_type: "reference", subject: ["architecture", ""] },
    () => classifyWithLLM(base),
  );
  assert.deepEqual(empty.subject, ["architecture"], "empty segment dropped");
  const punct = await withMock(
    { area: "infra", atom_type: "reference", subject: ["architecture", "###"] },
    () => classifyWithLLM(base),
  );
  assert.deepEqual(
    punct.subject,
    ["architecture"],
    "punctuation-only segment dropped, not 'untitled'",
  );
});

test("classifyWithLLM: an empty / absent subject is OMITTED (fallback applies downstream)", async () => {
  const empty = await withMock({ area: "infra", atom_type: "reference", subject: [] }, () =>
    classifyWithLLM(base),
  );
  assert.equal("subject" in empty, false);
  const absent = await withMock({ area: "infra", atom_type: "reference" }, () =>
    classifyWithLLM(base),
  );
  assert.equal("subject" in absent, false);
});

test("classifyWithLLM: a '/'-joined subject string is accepted (broad/narrow)", async () => {
  const out = await withMock({ subject: "operations/deploy" }, () => classifyWithLLM(base));
  assert.deepEqual(out.subject, ["operations", "deploy"]);
});

test("classifyWithLLM: without want.subject, no subject key is requested or returned-sanitized", async () => {
  const out = await withMock({ area: "infra", atom_type: "reference" }, () =>
    classifyWithLLM({ ...base, want: { area: true, atom_type: true } }),
  );
  assert.equal(out.area, "infra");
  assert.equal("subject" in out, false);
});
