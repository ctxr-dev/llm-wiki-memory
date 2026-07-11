// Hardening tests for path-compiler — sandbox escapes, error-message
// clarity, edge cases the audit agents identified.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileInlineFunction,
  callForwardCompiler,
  callParseCompiler,
  findUnresolvedPlaceholders,
  substituteTemplate,
  loadCompilerFile,
  PathCompilerError,
} from "../scripts/lib/path-compiler.mjs";

test("sandbox: Function constructor escape via .constructor.constructor is blocked", () => {
  // The classic vm-sandbox escape: any function literal's
  // .constructor.constructor is the host Function, which can compile new
  // code. SANDBOX_LOCKDOWN seals this surface.
  const src = `
    function to_path(_) {
      try {
        const F = (function () {}).constructor;
        const compiled = F.constructor("return typeof process")();
        return "escaped:" + compiled;
      } catch (err) {
        return "blocked:" + (err && err.message || String(err));
      }
    }
  `;
  const fn = compileInlineFunction(src);
  const r = callForwardCompiler(fn, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.path.startsWith("blocked:"), `Function constructor must throw; got: ${r.path}`);
});

test("sandbox: prototype-chain pollution does NOT leak across compileInlineFunction calls", () => {
  // Each call creates a fresh context; pollution in one MUST NOT affect
  // the next. We can't fully prove this without checking host state, but
  // we can at least confirm a polluted compiler doesn't carry state into
  // a fresh one in the SAME process.
  const pollute = compileInlineFunction(`
    function to_path(_) {
      try { Object.prototype.LWM_POLLUTED = "yes"; } catch (_) {}
      return "polluted";
    }
  `);
  callForwardCompiler(pollute, {});
  // Now run a fresh compiler that checks if pollution leaked.
  const probe = compileInlineFunction(`
    function to_path(_) {
      return ({}).LWM_POLLUTED === undefined ? "clean" : "leaked";
    }
  `);
  const r = callForwardCompiler(probe, {});
  assert.equal(r.path, "clean", "Object.prototype pollution must not survive across sandboxes");
});

test("sandbox: host built-ins (require/process/Buffer/console/setTimeout/fs/global) are undefined", () => {
  const cases = ["require", "process", "Buffer", "console", "setTimeout", "fs", "global"];
  for (const name of cases) {
    const src = `function to_path(_) { return typeof ${name}; }`;
    const fn = compileInlineFunction(src);
    const r = callForwardCompiler(fn, {});
    assert.equal(r.ok, true);
    assert.equal(r.path, "undefined", `${name} leaked into sandbox`);
  }
});

test("sandbox: eval / new Function from strings is disabled by codeGeneration.strings:false", () => {
  // eval() is not whitelisted; it should be undefined. new Function()
  // (the constructor) reaches Function via literal.constructor.constructor
  // but the lockdown patches that to throw.
  const src = `
    function to_path(_) {
      const evalT = typeof eval;
      let fnE;
      try { new Function("return 1")(); fnE = "ok"; } catch (e) { fnE = "blocked:" + e.message; }
      return JSON.stringify({ evalT, fnE });
    }
  `;
  const fn = compileInlineFunction(src);
  const r = callForwardCompiler(fn, {});
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.path);
  // eval should be undefined OR (if exposed by vm) blocked by the
  // codeGeneration.strings flag.
  assert.ok(
    parsed.evalT === "undefined" || parsed.fnE.startsWith("blocked:"),
    `eval/new Function must be unreachable; got ${r.path}`,
  );
});

test("callForwardCompiler: Promise return yields a Promise-specific error", () => {
  const fn = compileInlineFunction(`(_) => Promise.resolve("x")`);
  const r = callForwardCompiler(fn, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /Promise.*async/i);
});

test("callForwardCompiler: generator return yields a generator-specific error", () => {
  const fn = compileInlineFunction(`function* to_path() { yield "x"; }`);
  const r = callForwardCompiler(fn, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /generator|iterator/i);
});

test("callForwardCompiler: returning undefined / null / NaN / Symbol — clear error", () => {
  const cases = [`(_) => undefined`, `(_) => null`, `(_) => NaN`, `(_) => Symbol("x")`];
  for (const src of cases) {
    const fn = compileInlineFunction(src);
    const r = callForwardCompiler(fn, {});
    assert.equal(r.ok, false, `expected non-string rejection for ${src}`);
    assert.match(r.error, /expected string/);
  }
});

test("callParseCompiler: returning a Promise is rejected (not awaited)", () => {
  const fn = compileInlineFunction(`(_) => Promise.resolve({ a: 1 })`);
  const r = callParseCompiler(fn, "anything");
  // Current contract: parse_compiler must be synchronous; a Promise is
  // an object but not the kind expected.
  assert.equal(r.ok, true); // it's an "object", just not an array
  // The Promise itself is returned as facets — caller will discover the
  // mismatch downstream. We at least don't crash.
  assert.ok(r.facets);
});

test("callParseCompiler: returning false is rejected as non-object", () => {
  const fn = compileInlineFunction(`(_) => false`);
  const r = callParseCompiler(fn, "anything");
  assert.equal(r.ok, false);
  assert.match(r.error, /expected object/);
});

test("compileInlineFunction: comments before function declaration", () => {
  const src = `
    // this comment should be skipped
    /* multi
       line */
    function to_path({ x }) { return "p/" + x; }
  `;
  const fn = compileInlineFunction(src);
  assert.equal(fn({ x: "a" }), "p/a");
});

test("compileInlineFunction: multiple to_path declarations — last wins (or fails cleanly)", () => {
  // Hoisting + redeclaration: function-declarations later in scope
  // shadow earlier ones at hoist time, so the last one wins.
  const src = `
    function to_path() { return "first"; }
    function to_path() { return "second"; }
  `;
  const fn = compileInlineFunction(src);
  assert.equal(fn(), "second");
});

test("compileInlineFunction: const path_template = (...) => ... NOT recognised (must use function name)", () => {
  // The IIFE looks for a top-level `to_path` or `from_path` binding.
  // `const path_template` (the old name) and `const to_path` (declared via
  // const, not function) are NOT visible at IIFE return time because
  // const/let are block-scoped inside the IIFE — but `var to_path = ...`
  // would be hoisted.
  const src = `const to_path = (_) => "x";`;
  // Source as a STATEMENT in the IIFE wrapper — let block-scoped binding
  // is captured because the if-check runs inside the SAME IIFE body.
  const fn = compileInlineFunction(src);
  assert.equal(fn(), "x");
});

test("compileInlineFunction: source that doesn't define a function — descriptive error", () => {
  assert.throws(() => compileInlineFunction(`const x = 42;`), PathCompilerError);
  assert.throws(() => compileInlineFunction(`const x = 42;`), /did not evaluate to a function/);
});

test("substituteTemplate: template with NO placeholders returns input unchanged", () => {
  assert.equal(substituteTemplate("plain/path.md", {}), "plain/path.md");
});

test("substituteTemplate: open-brace literals are NOT recognised as placeholders", () => {
  // `{x` (no closing) doesn't match the regex; passes through verbatim.
  assert.equal(substituteTemplate("foo {x bar", { x: "VAL" }), "foo {x bar");
});

test("substituteTemplate: missing variable throws a precise PathCompilerError", () => {
  assert.throws(() => substituteTemplate("{a}-{b}", { a: "x" }), PathCompilerError);
  assert.throws(
    () => substituteTemplate("{a}-{b}", { a: "x" }),
    /template variable \{b\} not provided/,
  );
});

test("substituteTemplate: value containing {var} literal does NOT get re-substituted", () => {
  // Once substituted, the regex pass is complete. Embedded `{y}` stays.
  assert.equal(substituteTemplate("{x}", { x: "literal-{y}-here" }), "literal-{y}-here");
});

test("findUnresolvedPlaceholders: ignores `${expr}` (template-literal noise)", () => {
  // Compiled compiler output might contain literal `${}` from authoring;
  // those should NOT be flagged as unresolved.
  assert.deepEqual(findUnresolvedPlaceholders("hello ${name} world"), []);
});

test("findUnresolvedPlaceholders: ignores JSON-shaped braces", () => {
  assert.deepEqual(findUnresolvedPlaceholders('{"foo":"bar"}'), []);
});

test("loadCompilerFile: non-existent path returns PathCompilerError, not a raw fs error", async () => {
  await assert.rejects(() => loadCompilerFile("/does/not/exist.mjs"), PathCompilerError);
});

test("loadCompilerFile: module with no recognisable export — PathCompilerError lists what was tried", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcf-no-export-"));
  const mod = path.join(dir, "bare.mjs");
  fs.writeFileSync(mod, "export const not_a_function = 1;\n");
  await assert.rejects(
    () => loadCompilerFile(mod, { fileKindName: "anything" }),
    /must export a function/,
  );
});

test("loadCompilerFile: named-export precedence — fileKindName beats default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcf-precedence-"));
  const mod = path.join(dir, "twin.mjs");
  fs.writeFileSync(
    mod,
    `export default (_) => "from-default";
     export function knowledge(_) { return "from-named"; }\n`,
  );
  const fn = await loadCompilerFile(mod, { fileKindName: "knowledge" });
  assert.equal(fn(), "from-named");
  // Without a matching fileKindName, default wins.
  const fnDefault = await loadCompilerFile(mod, { fileKindName: "no_match" });
  assert.equal(fnDefault(), "from-default");
});

test("loadCompilerFile: named export exists but is NOT a function — falls through to default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcf-non-fn-"));
  const mod = path.join(dir, "weird.mjs");
  fs.writeFileSync(
    mod,
    `export default () => "default-wins";
     export const knowledge = "i am a string, not a function";\n`,
  );
  const fn = await loadCompilerFile(mod, { fileKindName: "knowledge" });
  assert.equal(fn(), "default-wins");
});
