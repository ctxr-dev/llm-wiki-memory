import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvValue } from "../scripts/lib/env.mjs";

test("parseEnvValue: bare value", () => {
  assert.equal(parseEnvValue("daily"), "daily");
});

test("parseEnvValue: trims surrounding whitespace", () => {
  assert.equal(parseEnvValue("  daily  "), "daily");
});

test("parseEnvValue: strips an inline comment (whitespace + #)", () => {
  assert.equal(parseEnvValue("daily   # flush writes here"), "daily");
});

test("parseEnvValue: a '#' with no preceding whitespace is kept", () => {
  assert.equal(parseEnvValue("ab#c"), "ab#c");
});

test("parseEnvValue: double-quoted value keeps an inner # and drops a trailing comment", () => {
  assert.equal(parseEnvValue('"a#b"  # note'), "a#b");
});

test("parseEnvValue: single-quoted value", () => {
  assert.equal(parseEnvValue("'value'"), "value");
});

test("parseEnvValue: unterminated quote is returned literally", () => {
  assert.equal(parseEnvValue('"oops'), '"oops');
});

test("parseEnvValue: a leading '#' is a full comment -> empty", () => {
  assert.equal(parseEnvValue("# just a comment"), "");
});

test("parseEnvValue: empty / whitespace -> empty", () => {
  assert.equal(parseEnvValue(""), "");
  assert.equal(parseEnvValue("   "), "");
});
