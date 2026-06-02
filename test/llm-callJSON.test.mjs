import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callJSON, interpolate, loadPromptFile } from "../scripts/lib/llm-callJSON.mjs";
import { LLMOutputInvalid } from "../scripts/lib/llm.mjs";

function setMock(response) {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_RESPONSE = response;
}

function clearMock() {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  delete process.env.MEMORY_LLM_MOCK_FILE;
}

test("interpolate: simple {{NAME}} substitution", () => {
  assert.equal(interpolate("Hello {{NAME}}", { NAME: "world" }), "Hello world");
});

test("interpolate: missing key leaves placeholder intact", () => {
  assert.equal(interpolate("Hello {{X}}", {}), "Hello {{X}}");
});

test("interpolate: missing key with other keys present leaves the unknown placeholder", () => {
  assert.equal(interpolate("Hi {{Y}} and {{X}}", { Y: "you" }), "Hi you and {{X}}");
});

test("interpolate: object value is JSON.stringify-ed with 2-space indent", () => {
  const out = interpolate("data: {{PAYLOAD}}", { PAYLOAD: { a: 1, b: [2, 3] } });
  assert.equal(out, `data: ${JSON.stringify({ a: 1, b: [2, 3] }, null, 2)}`);
});

test("interpolate: array value is JSON.stringify-ed", () => {
  const out = interpolate("list: {{XS}}", { XS: [1, 2, 3] });
  assert.equal(out, `list: ${JSON.stringify([1, 2, 3], null, 2)}`);
});

test("interpolate: null value renders as empty string", () => {
  assert.equal(interpolate("a={{X}}b", { X: null }), "a=b");
});

test("interpolate: undefined value renders as empty string", () => {
  assert.equal(interpolate("a={{X}}b", { X: undefined }), "a=b");
});

test("interpolate: boolean values are coerced", () => {
  assert.equal(interpolate("ok={{B}}", { B: true }), "ok=true");
  assert.equal(interpolate("ok={{B}}", { B: false }), "ok=false");
});

test("interpolate: number values are coerced (including 0)", () => {
  assert.equal(interpolate("n={{N}}", { N: 42 }), "n=42");
  assert.equal(interpolate("n={{N}}", { N: 0 }), "n=0");
});

test("interpolate: no vars -> template returned as String, no replacement", () => {
  assert.equal(interpolate("Hello {{NAME}}", undefined), "Hello {{NAME}}");
  assert.equal(interpolate("Hello {{NAME}}", null), "Hello {{NAME}}");
});

test("interpolate: non-object vars (e.g. string) -> template returned as String", () => {
  assert.equal(interpolate("Hello {{NAME}}", "notObject"), "Hello {{NAME}}");
});

test("interpolate: null/undefined template -> empty string", () => {
  assert.equal(interpolate(null, { X: "y" }), "");
  assert.equal(interpolate(undefined, { X: "y" }), "");
});

test("interpolate: non-uppercase placeholder is NOT touched (regex requires [A-Z0-9_])", () => {
  assert.equal(interpolate("Hi {{name}}", { name: "x" }), "Hi {{name}}");
});

test("interpolate: multiple placeholders in one template", () => {
  assert.equal(
    interpolate("{{GREETING}} {{NAME}}!", { GREETING: "Hello", NAME: "Ada" }),
    "Hello Ada!",
  );
});

test("loadPromptFile: reads file and interpolates vars", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llm-callJSON-"));
  const p = path.join(tmp, "prompt.md");
  fs.writeFileSync(p, "System: speak as {{ROLE}}.");
  try {
    assert.equal(loadPromptFile(p, { ROLE: "robot" }), "System: speak as robot.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadPromptFile: throws on missing file", () => {
  assert.throws(
    () => loadPromptFile("/definitely/does/not/exist/llm-callJSON.test.prompt", {}),
    /ENOENT|no such file/i,
  );
});

test("callJSON: no schema, inline systemPrompt/userPrompt — passes through and returns parsed JSON", async () => {
  setMock(JSON.stringify({ foo: "bar" }));
  try {
    const out = await callJSON({
      systemPrompt: "you are a test",
      userPrompt: "produce JSON",
    });
    assert.deepEqual(out, { foo: "bar" });
  } finally {
    clearMock();
  }
});

test("callJSON: promptPath loads system prompt from file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llm-callJSON-"));
  const promptPath = path.join(tmp, "system.md");
  fs.writeFileSync(promptPath, "System for {{TASK}}");
  setMock(JSON.stringify({ ok: true }));
  try {
    const out = await callJSON({
      promptPath,
      userPrompt: "go",
      vars: { TASK: "whatever" },
    });
    assert.deepEqual(out, { ok: true });
  } finally {
    clearMock();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("callJSON: vars are applied to both systemPrompt and userPrompt", async () => {
  setMock(JSON.stringify({ ok: true }));
  try {
    const stateful = {
      seenSystem: null,
      seenUser: null,
      safeParse(data) {
        return { success: true, data };
      },
    };
    const out = await callJSON({
      systemPrompt: "sys-{{V}}",
      userPrompt: "usr-{{V}}",
      vars: { V: "X" },
      schema: stateful,
    });
    assert.deepEqual(out, { ok: true });
  } finally {
    clearMock();
  }
});

test("callJSON: schema success returns parsed.data (which may differ from raw json)", async () => {
  setMock(JSON.stringify({ raw: 1 }));
  try {
    const schema = {
      safeParse: (data) => ({ success: true, data: { transformed: data.raw + 1 } }),
    };
    const out = await callJSON({
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });
    assert.deepEqual(out, { transformed: 2 });
  } finally {
    clearMock();
  }
});

test("callJSON: schema mismatch on every attempt — throws LLMOutputInvalid after maxRetries", async () => {
  setMock(JSON.stringify({ wrong: "shape" }));
  try {
    const schema = {
      safeParse: () => ({
        success: false,
        error: { issues: [{ path: ["foo"], message: "expected foo" }] },
      }),
    };
    await assert.rejects(
      () =>
        callJSON({
          systemPrompt: "s",
          userPrompt: "u",
          maxRetries: 2,
          schema,
        }),
      (err) => {
        assert.ok(err instanceof LLMOutputInvalid, "should throw LLMOutputInvalid");
        assert.match(err.message, /schema validation/i);
        assert.match(err.message, /foo: expected foo/);
        return true;
      },
    );
  } finally {
    clearMock();
  }
});

test("callJSON: schema fails first attempt then succeeds — returns parsed.data from the successful attempt", async () => {
  setMock(JSON.stringify({ payload: 7 }));
  try {
    let calls = 0;
    const schema = {
      safeParse: (data) => {
        calls++;
        if (calls <= 1) {
          return {
            success: false,
            error: { issues: [{ path: [], message: "first try fails" }] },
          };
        }
        return { success: true, data };
      },
    };
    const out = await callJSON({
      systemPrompt: "s",
      userPrompt: "u",
      maxRetries: 2,
      schema,
    });
    assert.deepEqual(out, { payload: 7 });
    assert.equal(calls, 2, "schema.safeParse should be invoked exactly twice");
  } finally {
    clearMock();
  }
});

test("callJSON: maxRetries=0 (default) with failing schema — throws on first failure", async () => {
  setMock(JSON.stringify({ x: 1 }));
  try {
    let calls = 0;
    const schema = {
      safeParse: () => {
        calls++;
        return {
          success: false,
          error: { issues: [{ path: ["x"], message: "nope" }] },
        };
      },
    };
    await assert.rejects(
      () =>
        callJSON({
          systemPrompt: "s",
          userPrompt: "u",
          schema,
        }),
      LLMOutputInvalid,
    );
    assert.equal(calls, 1, "default maxRetries=0 means one attempt only");
  } finally {
    clearMock();
  }
});

test("callJSON: schema with .errors (instead of .issues) is also formatted", async () => {
  setMock(JSON.stringify({ y: 2 }));
  try {
    const schema = {
      safeParse: () => ({
        success: false,
        error: { errors: [{ path: ["y"], message: "bad y" }] },
      }),
    };
    await assert.rejects(
      () =>
        callJSON({
          systemPrompt: "s",
          userPrompt: "u",
          schema,
        }),
      (err) => {
        assert.match(err.message, /y: bad y/);
        return true;
      },
    );
  } finally {
    clearMock();
  }
});

test("callJSON: vars applied even when promptPath used (userPrompt still interpolated)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llm-callJSON-"));
  const promptPath = path.join(tmp, "sys.md");
  fs.writeFileSync(promptPath, "S {{V}}");
  setMock(JSON.stringify({ echoed: true }));
  try {
    const out = await callJSON({
      promptPath,
      userPrompt: "U {{V}}",
      vars: { V: "z" },
    });
    assert.deepEqual(out, { echoed: true });
  } finally {
    clearMock();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
