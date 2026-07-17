import fs from "node:fs";
import path from "node:path";

// Dep-free glob matching + file collection for `absorb`. `fs.globSync` is
// Node-22-only and the runtime supports Node >=20, so we hand-roll a small,
// well-tested matcher. Paths are normalised to forward slashes so a glob
// behaves identically on POSIX and Windows.

const norm = (/** @type {string} */ p) => String(p || "").replace(/\\/g, "/");

// Translate a single `{…}` alternative: it may itself contain `*`/`?` wildcards
// (e.g. `{*.md,*.txt}`), so run them through the same wildcard rules rather than
// emitting them literally — a bare `*` would otherwise produce an invalid regex.
/** @param {string} alt @returns {string} */
function altToRegExp(alt) {
  let out = "";
  for (const c of alt) {
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(c)) out += `\\${c}`;
    else out += c;
  }
  return out;
}

/**
 * Compile a glob to a RegExp. Supports `**` (any depth, crossing `/`), `*` (a
 * single path segment, not crossing `/`), `?` (one non-`/` char), and `{a,b}`
 * alternation. Everything else is matched literally. Case-insensitive.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const g = norm(glob);
  let re = "";
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**` (optionally `**/`) matches any number of segments, including none.
        i += 1;
        if (g[i + 1] === "/") i += 1;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = g.slice(i + 1, end).split(",");
        re += `(?:${alts.map(altToRegExp).join("|")})`;
        i = end;
      }
    } else if (/[.+^$()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  // Case-INSENSITIVE: on a case-insensitive filesystem (macOS default) a
  // `**/*.md` mask must still match `GUIDE.MD` / `README.Markdown`.
  return new RegExp(`^${re}$`, "i");
}

/**
 * @param {string} name @param {string[]} masks @returns {boolean}
 */
export function matchesAnyMask(name, masks) {
  const n = norm(name);
  return masks.some((m) => globToRegExp(m).test(n) || globToRegExp(m).test(path.posix.basename(n)));
}

/** @param {string} dir @param {string[]} out @returns {string[]} */
function walkDir(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory (EACCES etc.) is skipped, not fatal — one bad
    // subtree must never abort a whole absorb batch.
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      walkDir(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

const DEFAULT_MASKS = Object.freeze(["**/*.md", "**/*.markdown"]);

/**
 * Resolve `paths` (each a file, a directory, or a glob) into the files to
 * absorb, keeping only those whose path/basename matches any `masks` glob
 * (default markdown). Each result carries the `root` it was collected under —
 * the base for the leaf-name slug (so same-basename files in different subdirs
 * stay distinct and re-absorbing the same root is idempotent). Deduped by
 * absolute path.
 * @param {string[]} paths
 * @param {string[]} [masks]
 * @returns {{ file: string, root: string }[]}
 */
export function collectFiles(paths, masks = [...DEFAULT_MASKS]) {
  /** @type {Map<string, string>} */
  const byAbs = new Map(); // absFile -> root
  for (const entry of paths || []) {
    const raw = String(entry || "");
    let stat = null;
    try {
      stat = fs.statSync(raw);
    } catch {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      const root = path.resolve(raw);
      for (const f of walkDir(root, [])) {
        if (matchesAnyMask(path.relative(root, f), masks)) byAbs.set(path.resolve(f), root);
      }
    } else if (stat && stat.isFile()) {
      // An explicit file is taken as-is (masks don't filter a named file); its
      // root is the parent dir, so the leaf name is the bare basename.
      const abs = path.resolve(raw);
      byAbs.set(abs, path.dirname(abs));
    } else {
      // Treat as a glob: walk its non-glob prefix directory and match the tail.
      const g = norm(raw);
      const firstGlob = g.search(/[*?{]/);
      const prefix = firstGlob === -1 ? g : g.slice(0, g.lastIndexOf("/", firstGlob) + 1);
      const baseDir = path.resolve(prefix || ".");
      let base = null;
      try {
        base = fs.statSync(baseDir);
      } catch {
        base = null;
      }
      if (!base || !base.isDirectory()) continue;
      const re = globToRegExp(path.isAbsolute(g) ? g : norm(path.resolve(g)));
      for (const f of walkDir(baseDir, [])) {
        const abs = path.resolve(f);
        if (re.test(norm(abs)) && matchesAnyMask(path.relative(baseDir, f), masks)) {
          byAbs.set(abs, baseDir);
        }
      }
    }
  }
  return [...byAbs.entries()]
    .map(([file, root]) => ({ file, root }))
    .sort((a, b) => (a.file < b.file ? -1 : 1));
}
