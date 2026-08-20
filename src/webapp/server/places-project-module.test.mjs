import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openAppDb } from "./app-db.mjs";

test("addPlace persists projectModule; listPlaces returns it (null when absent)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appdb-pm-"));
  try {
    const db = openAppDb(path.join(dir, "app.sqlite"));
    db.addPlace({ root: "/r/a", mountDir: "/m/a", label: "A", projectModule: "acme/widget" });
    db.addPlace({ root: "/r/b", mountDir: "/m/b", label: "B" });
    const places = db.listPlaces();
    expect(places.find((p) => p.root === "/r/a")?.projectModule).toBe("acme/widget");
    expect(places.find((p) => p.root === "/r/b")?.projectModule).toBeNull();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-adding a place without projectModule preserves the stored value (COALESCE, no wipe)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appdb-coalesce-"));
  try {
    const db = openAppDb(path.join(dir, "app.sqlite"));
    db.addPlace({ root: "/r/a", mountDir: "/m/a", label: "A", projectModule: "acme/widget" });
    db.addPlace({ root: "/r/a", mountDir: "/m/a2" });
    const place = db.listPlaces().find((p) => p.root === "/r/a");
    expect(place?.projectModule).toBe("acme/widget");
    expect(place?.label).toBe("A");
    expect(place?.mountDir).toBe("/m/a2");
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates a pre-existing DB that lacks the project_module column", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appdb-mig-"));
  const dbPath = path.join(dir, "app.sqlite");
  try {
    const old = new Database(dbPath);
    old.exec(
      "CREATE TABLE places (root TEXT PRIMARY KEY, mount_dir TEXT NOT NULL, label TEXT, added_at INTEGER NOT NULL)",
    );
    old
      .prepare("INSERT INTO places(root, mount_dir, label, added_at) VALUES (?,?,?,?)")
      .run("/r/old", "/m/old", "Old", 1);
    old.close();

    const db = openAppDb(dbPath);
    const places = db.listPlaces();
    expect(places[0].root).toBe("/r/old");
    expect(places[0].projectModule).toBeNull();
    db.addPlace({ root: "/r/new", mountDir: "/m/new", label: "New", projectModule: "acme/x" });
    expect(db.listPlaces().find((p) => p.root === "/r/new")?.projectModule).toBe("acme/x");
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
