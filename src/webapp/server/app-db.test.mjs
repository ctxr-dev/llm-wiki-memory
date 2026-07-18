import { test, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAppDb } from "./app-db.mjs";

const created = [];

function freshDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-appdb-"));
  created.push(dir);
  return path.join(dir, "state", "app.sqlite");
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("openAppDb creates the db file and its parent directory", () => {
  const dbPath = freshDbPath();
  const db = openAppDb(dbPath);
  expect(fs.existsSync(dbPath)).toBe(true);
  db.close();
});

test("addPlace + listPlaces round-trips and upserts by root", () => {
  const db = openAppDb(freshDbPath(), { now: () => 111 });
  db.addPlace({ root: path.join("/w", "a", "wiki"), mountDir: path.join("/w", "a"), label: "A" });
  db.addPlace({ root: path.join("/w", "b", "wiki"), mountDir: path.join("/w", "b") });
  expect(db.listPlaces().length).toBe(2);
  db.addPlace({ root: path.join("/w", "a", "wiki"), mountDir: path.join("/w", "a"), label: "A2" });
  const list = db.listPlaces();
  expect(list.length).toBe(2);
  expect(list.find((p) => p.mountDir === path.join("/w", "a"))?.label).toBe("A2");
  db.close();
});

test("removePlace deletes and reports whether a row was removed", () => {
  const db = openAppDb(freshDbPath());
  db.addPlace({ root: "/w/a", mountDir: "/w/a" });
  expect(db.removePlace("/w/a")).toBe(true);
  expect(db.listPlaces().length).toBe(0);
  expect(db.removePlace("/nope")).toBe(false);
  db.close();
});

test("prefs get/set upserts by (scope, key)", () => {
  const db = openAppDb(freshDbPath());
  expect(db.getPref("tabs", "open")).toBe(null);
  db.setPref("tabs", "open", "[1,2]");
  expect(db.getPref("tabs", "open")).toBe("[1,2]");
  db.setPref("tabs", "open", "[3]");
  expect(db.getPref("tabs", "open")).toBe("[3]");
  db.close();
});

test("places persist across reopen (durable WAL)", () => {
  const dbPath = freshDbPath();
  const first = openAppDb(dbPath);
  first.addPlace({ root: "/w/a", mountDir: "/w/a" });
  first.close();
  const second = openAppDb(dbPath);
  expect(second.listPlaces().length).toBe(1);
  second.close();
});
