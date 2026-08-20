import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

const LAYOUT = "layout:\n  - path: shared_notes\n    ownership: repo\n";

function makeWikiMount() {
  const mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-wa-mount-")));
  const wiki = path.join(mount, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(wiki, { recursive: true });
  fs.writeFileSync(path.join(wiki, "layout.yaml"), LAYOUT);
  return mount;
}

let app;
let db;
let dataDir;
let extraMount;
let buildApp;

beforeAll(async () => {
  ({ dataDir } = setupWorkspace());
  const { openAppDb } = await import("./app-db.mjs");
  ({ buildApp } = await import("./index.mjs"));
  db = openAppDb(path.join(dataDir, "webapp-test", "app.sqlite"));
  app = buildApp({ db });
  await app.ready();
  extraMount = makeWikiMount();
});

async function withPicker(pickFolder, run) {
  const picker = buildApp({ db, pickFolder });
  await picker.ready();
  try {
    return await run(picker);
  } finally {
    await picker.close();
  }
}

afterAll(async () => {
  if (app) await app.close();
  if (db) db.close();
  if (extraMount) fs.rmSync(extraMount, { recursive: true, force: true });
  if (dataDir) cleanup(dataDir);
});

test("GET /api/wikis lists the home brain first", async () => {
  const res = await app.inject({ method: "GET", url: "/api/wikis" });
  expect(res.statusCode).toBe(200);
  const { wikis } = res.json();
  expect(wikis[0].kind).toBe("home");
  expect(wikis[0].categories.length).toBeGreaterThan(0);
});

test("POST /api/wikis adds a valid wiki folder", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/wikis",
    payload: { path: extraMount },
  });
  expect(res.statusCode).toBe(200);
  const { wiki } = res.json();
  expect(wiki.kind).toBe("added");
  expect(wiki.categories).toContain("shared_notes");
  const list = (await app.inject({ method: "GET", url: "/api/wikis" })).json();
  expect(list.wikis.some((w) => w.mountDir === extraMount)).toBe(true);
});

test("POST rejects a malformed body (400) via the strict schema", async () => {
  const missing = await app.inject({ method: "POST", url: "/api/wikis", payload: {} });
  expect(missing.statusCode).toBe(400);
  const extra = await app.inject({
    method: "POST",
    url: "/api/wikis",
    payload: { path: extraMount, rogue: 1 },
  });
  expect(extra.statusCode).toBe(400);
});

test("POST rejects a relative path (400, refused not resolved)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/wikis",
    payload: { path: path.join("relative", "dir") },
  });
  expect(res.statusCode).toBe(400);
});

test("POST rejects an empty path (400) via the min-length schema", async () => {
  const res = await app.inject({ method: "POST", url: "/api/wikis", payload: { path: "" } });
  expect(res.statusCode).toBe(400);
});

test("POST rejects a plain (non-wiki) folder (422)", async () => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-wa-plain-")));
  const res = await app.inject({ method: "POST", url: "/api/wikis", payload: { path: plain } });
  expect(res.statusCode).toBe(422);
  fs.rmSync(plain, { recursive: true, force: true });
});

test("DELETE removes an added wiki by id", async () => {
  const before = (await app.inject({ method: "GET", url: "/api/wikis" })).json();
  const added = before.wikis.find((w) => w.kind === "added");
  const res = await app.inject({ method: "DELETE", url: `/api/wikis/${added.id}` });
  expect(res.statusCode).toBe(200);
  const after = (await app.inject({ method: "GET", url: "/api/wikis" })).json();
  expect(after.wikis.some((w) => w.id === added.id)).toBe(false);
});

test("a place whose folder was deleted is skipped from the list, not fatal", async () => {
  const gone = makeWikiMount();
  await app.inject({ method: "POST", url: "/api/wikis", payload: { path: gone } });
  fs.rmSync(gone, { recursive: true, force: true });
  const res = await app.inject({ method: "GET", url: "/api/wikis" });
  expect(res.statusCode).toBe(200);
  expect(res.json().wikis.some((w) => w.mountDir === gone)).toBe(false);
});

test("POST /api/pick-folder returns the natively-picked absolute path", async () => {
  await withPicker(
    async () => "/picked/wiki",
    async (picker) => {
      const res = await picker.inject({ method: "POST", url: "/api/pick-folder" });
      expect(res.statusCode).toBe(200);
      expect(res.json().path).toBe("/picked/wiki");
    },
  );
});

test("POST /api/pick-folder returns an empty path when the user cancels", async () => {
  await withPicker(
    async () => "",
    async (picker) => {
      const res = await picker.inject({ method: "POST", url: "/api/pick-folder" });
      expect(res.statusCode).toBe(200);
      expect(res.json().path).toBe("");
    },
  );
});

test("POST /api/pick-folder maps an unsupported platform to 501", async () => {
  await withPicker(
    async () => {
      throw new Error("unsupported");
    },
    async (picker) => {
      const res = await picker.inject({ method: "POST", url: "/api/pick-folder" });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toBe("unsupported");
    },
  );
});

test("POST /api/pick-folder maps an unexpected failure to 500", async () => {
  await withPicker(
    async () => {
      throw new Error("boom");
    },
    async (picker) => {
      const res = await picker.inject({ method: "POST", url: "/api/pick-folder" });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("pick-failed");
    },
  );
});

test("POST /api/pick-folder rejects a cross-origin request (403) without invoking the picker", async () => {
  let called = false;
  await withPicker(
    async () => {
      called = true;
      return "/x";
    },
    async (picker) => {
      const res = await picker.inject({
        method: "POST",
        url: "/api/pick-folder",
        headers: { origin: "http://evil.example", host: "127.0.0.1:4319" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
      expect(called).toBe(false);
    },
  );
});

test("POST /api/pick-folder allows a same-origin request", async () => {
  await withPicker(
    async () => "/x",
    async (picker) => {
      const res = await picker.inject({
        method: "POST",
        url: "/api/pick-folder",
        headers: { origin: "http://127.0.0.1:4319", host: "127.0.0.1:4319" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().path).toBe("/x");
    },
  );
});

test("POST /api/pick-folder rejects a concurrent pick already in flight (409)", async () => {
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withPicker(
    async () => {
      enter();
      await gate;
      return "/x";
    },
    async (picker) => {
      const first = picker.inject({ method: "POST", url: "/api/pick-folder" });
      await entered;
      const second = await picker.inject({ method: "POST", url: "/api/pick-folder" });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("busy");
      release();
      expect((await first).statusCode).toBe(200);
    },
  );
});
