import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MEMORY_DATA_DIR } from "../../../scripts/lib/env.mjs";

const DEFAULT_DB_PATH = path.join(MEMORY_DATA_DIR, "webapp", "app.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS places (
  root TEXT PRIMARY KEY,
  mount_dir TEXT NOT NULL,
  label TEXT,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_stats (
  root TEXT NOT NULL,
  facet_path TEXT NOT NULL,
  count INTEGER NOT NULL,
  mtime_token TEXT NOT NULL,
  PRIMARY KEY (root, facet_path)
);
CREATE TABLE IF NOT EXISTS prefs (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

/**
 * @typedef {{ root: string, mountDir: string, label: string | null }} Place
 * @typedef {ReturnType<typeof openAppDb>} AppDb
 */

/**
 * @param {string} [dbPath]
 * @param {{ now?: () => number }} [opts]
 */
export function openAppDb(dbPath = DEFAULT_DB_PATH, { now = () => Date.now() } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);

  const insertPlace = db.prepare(
    "INSERT INTO places(root, mount_dir, label, added_at) VALUES (@root, @mountDir, @label, @addedAt) " +
      "ON CONFLICT(root) DO UPDATE SET mount_dir = excluded.mount_dir, label = COALESCE(excluded.label, label)",
  );
  const selectPlaces = db.prepare(
    "SELECT root, mount_dir AS mountDir, label FROM places ORDER BY added_at ASC, root ASC",
  );
  const deletePlace = db.prepare("DELETE FROM places WHERE root = ?");
  const upsertPref = db.prepare(
    "INSERT INTO prefs(scope, key, value) VALUES (@scope, @key, @value) " +
      "ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
  );
  const selectPref = db.prepare("SELECT value FROM prefs WHERE scope = ? AND key = ?");
  const upsertStat = db.prepare(
    "INSERT INTO doc_stats(root, facet_path, count, mtime_token) VALUES (@root, @facetPath, @count, @token) " +
      "ON CONFLICT(root, facet_path) DO UPDATE SET count = excluded.count, mtime_token = excluded.mtime_token",
  );
  const selectStat = db.prepare(
    "SELECT count, mtime_token AS mtimeToken FROM doc_stats WHERE root = ? AND facet_path = ?",
  );

  return {
    /** @param {{ root: string, mountDir: string, label?: string | null }} place */
    addPlace: (place) =>
      insertPlace.run({
        root: place.root,
        mountDir: place.mountDir,
        label: place.label ?? null,
        addedAt: now(),
      }),
    /** @returns {Place[]} */
    listPlaces: () => /** @type {Place[]} */ (selectPlaces.all()),
    /** @param {string} root @returns {boolean} */
    removePlace: (root) => deletePlace.run(root).changes > 0,
    /** @param {string} scope @param {string} key @returns {string | null} */
    getPref: (scope, key) => {
      const row = /** @type {{ value: string } | undefined} */ (selectPref.get(scope, key));
      return row ? row.value : null;
    },
    /** @param {string} scope @param {string} key @param {string} value */
    setPref: (scope, key, value) => upsertPref.run({ scope, key, value }),
    /** @param {string} root @param {string} facetPath @returns {{ count: number, mtimeToken: string } | null} */
    getStat: (root, facetPath) =>
      /** @type {{ count: number, mtimeToken: string } | undefined} */ (
        selectStat.get(root, facetPath)
      ) ?? null,
    /** @param {string} root @param {string} facetPath @param {number} count @param {string} token */
    setStat: (root, facetPath, count, token) => upsertStat.run({ root, facetPath, count, token }),
    close: () => db.close(),
  };
}
