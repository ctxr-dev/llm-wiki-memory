// Layout-template resolution + install. The `examples/layouts/<name>/` folders
// are the SINGLE source of truth for shipped layouts (there is no separate
// `templates/llmwiki.layout.yaml` copy any more). `cmdInit` and the federated
// mount provisioner both install a chosen template through here, so the copy
// semantics (whole-folder recursive, so a topology template's sibling
// to_path/from_path helpers travel) live in one place.

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR } from "./env.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

const TEMPLATES_DIR = path.join(MEMORY_DIR, "examples", "layouts");
export const DEFAULT_TEMPLATE = "default";

// A template name is a single safe directory segment — never a path fragment.
const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Template folder names that ship with a `layout.yaml`, sorted.
 * @returns {string[]}
 */
function availableTemplates() {
  /** @type {string[]} */
  const names = [];
  let entries;
  try {
    entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const e of entries) {
    if (e.isDirectory() && fs.existsSync(path.join(TEMPLATES_DIR, e.name, "layout.yaml"))) {
      names.push(e.name);
    }
  }
  return names.sort();
}

/**
 * Resolve a template folder by name, FAIL-CLOSED: an unsafe or unknown name (or
 * one whose folder lacks a `layout.yaml`) throws with the list of valid names,
 * rather than silently falling back to a default.
 * @param {string} name
 * @returns {string} absolute template directory
 */
function resolveTemplateDir(name) {
  const n = String(name || "").trim();
  if (!SAFE_NAME.test(n)) {
    throw new Error(
      `unknown layout template "${name}". Available templates: ${availableTemplates().join(", ")}`,
    );
  }
  const dir = path.join(TEMPLATES_DIR, n);
  if (!fs.existsSync(path.join(dir, "layout.yaml"))) {
    throw new Error(
      `unknown layout template "${name}". Available templates: ${availableTemplates().join(", ")}`,
    );
  }
  return dir;
}

/**
 * Recursively copy a template folder's contents into `layoutDir`, every file
 * through `writeFileAtomic` (templates are durable install artifacts). The
 * whole folder is copied so a topology template's sibling `to_path.mjs` /
 * `from_path.mjs` helpers land beside the contract.
 * @param {string} srcDir absolute source folder
 * @param {string} destDir absolute destination folder
 * @returns {string[]} relative paths written (sorted)
 */
function copyTreeAtomic(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  /** @type {string[]} */
  const written = [];
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      for (const rel of copyTreeAtomic(src, dest)) written.push(path.join(ent.name, rel));
    } else if (ent.isFile()) {
      writeFileAtomic(dest, fs.readFileSync(src));
      written.push(ent.name);
    }
  }
  return written.sort();
}

/**
 * Install the named template into `layoutDir` (the wiki's `.layout` folder).
 * FAIL-CLOSED on an unknown name.
 * @param {string} layoutDir absolute `.layout` directory
 * @param {string} name template name
 * @returns {{ template: string, files: string[] }}
 */
export function installLayoutTemplate(layoutDir, name) {
  const srcDir = resolveTemplateDir(name);
  return { template: path.basename(srcDir), files: copyTreeAtomic(srcDir, layoutDir) };
}
