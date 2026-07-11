import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileInlineFunction,
  callForwardCompiler,
  callParseCompiler,
  findUnresolvedPlaceholders,
  substituteTemplate,
  PathCompilerError,
} from "../scripts/lib/path-compiler.mjs";

test("compileInlineFunction accepts a named function declaration (to_path)", () => {
  const src = `
    function to_path({ tracker, prefix, number }) {
      return tracker + "/" + prefix + "/" + number;
    }
  `;
  const fn = compileInlineFunction(src);
  assert.equal(typeof fn, "function");
  assert.equal(fn({ tracker: "JIRA", prefix: "DEV", number: 42 }), "JIRA/DEV/42");
});

test("compileInlineFunction accepts a named function declaration (from_path)", () => {
  // Note: parseInt is NOT in the sandbox whitelist. We use Number(...) (the
  // Number constructor IS whitelisted) for integer coercion inside compilers.
  const src = `
    function from_path(rel) {
      const m = /(\\w+)-(\\d+)/.exec(rel);
      return m ? { key: m[1], n: Number(m[2]) } : null;
    }
  `;
  const fn = compileInlineFunction(src);
  const result = fn("DEV-129957");
  // sandboxed objects have a different Object prototype than the host realm,
  // so deepStrictEqual (the default for node:assert/strict) treats them as
  // not-equal. Compare property by property.
  assert.ok(result);
  assert.equal(result.key, "DEV");
  assert.equal(result.n, 129957);
});

test("compileInlineFunction accepts an arrow expression", () => {
  const src = `({ a, b }) => a + b`;
  const fn = compileInlineFunction(src);
  assert.equal(fn({ a: 3, b: 4 }), 7);
});

test("compileInlineFunction is sandboxed (no require, process, Buffer, fs, console)", () => {
  // `globalThis` inside a vm context IS the sandbox object — that's the
  // standard JS semantics, not a leak. We assert the host-specific bindings
  // are out of reach.
  const cases = [
    `function to_path() { return typeof require; }`,
    `function to_path() { return typeof process; }`,
    `function to_path() { return typeof Buffer; }`,
    `function to_path() { return typeof console; }`,
    `function to_path() { return typeof setTimeout; }`,
  ];
  for (const src of cases) {
    const fn = compileInlineFunction(src);
    assert.equal(fn(), "undefined", `expected ${src} to see undefined in sandbox`);
  }
});

test("compileInlineFunction exposes Math + JSON + RegExp + Date inside the sandbox", () => {
  const src = `
    function to_path({ n }) {
      return JSON.stringify({ floor: Math.floor(n / 3), match: /\\d+/.test(String(n)) });
    }
  `;
  const fn = compileInlineFunction(src);
  assert.equal(fn({ n: 10 }), '{"floor":3,"match":true}');
});

test("compileInlineFunction rejects empty / non-string source", () => {
  assert.throws(() => compileInlineFunction(""), /non-empty/);
  assert.throws(() => compileInlineFunction(null), /non-empty/);
  assert.throws(() => compileInlineFunction(42), /non-empty/);
});

test("compileInlineFunction rejects source that doesn't produce a function", () => {
  assert.throws(() => compileInlineFunction(`const x = 42;`), /did not evaluate to a function/);
});

test("callForwardCompiler returns { ok: false } on runtime errors", () => {
  const fn = compileInlineFunction(`() => { throw new Error("boom"); }`);
  const r = callForwardCompiler(fn, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test("callForwardCompiler returns { ok: false } when the compiler returns a non-string", () => {
  const fn = compileInlineFunction(`() => 42`);
  const r = callForwardCompiler(fn, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /number.*expected string/);
});

test("callParseCompiler tolerates null (no match) and rejects non-object returns", () => {
  const fnNull = compileInlineFunction(`() => null`);
  assert.deepEqual(callParseCompiler(fnNull, "x"), { ok: true, facets: null, error: null });

  const fnArr = compileInlineFunction(`() => [1, 2]`);
  const r = callParseCompiler(fnArr, "x");
  assert.equal(r.ok, false);
  assert.match(r.error, /expected object/);
});

test("findUnresolvedPlaceholders finds any leftover {var} in a result string", () => {
  assert.deepEqual(findUnresolvedPlaceholders("issues/JIRA/{prefix}/{number}.md"), [
    "{prefix}",
    "{number}",
  ]);
  assert.deepEqual(findUnresolvedPlaceholders("issues/clean/path.md"), []);
});

test("substituteTemplate fills {var} placeholders from a flat object", () => {
  const r = substituteTemplate("issues/{tracker}/{prefix}-{n}.md", {
    tracker: "JIRA",
    prefix: "DEV",
    n: 42,
  });
  assert.equal(r, "issues/JIRA/DEV-42.md");
});

test("substituteTemplate throws PathCompilerError on a missing variable", () => {
  assert.throws(() => substituteTemplate("{a}-{b}", { a: 1 }), PathCompilerError);
});
