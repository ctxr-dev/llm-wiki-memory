import crypto from "node:crypto";
import path from "node:path";

/** @param {string} root @returns {string} */
export function hashRoot(root) {
  return crypto.createHash("sha1").update(root).digest("hex").slice(0, 12);
}

/** @param {string} slug @returns {string} */
export function prettify(slug) {
  const words = slug.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return slug;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * @param {{ root: string, mountDir: string, projectModule?: string, ownership: string, label?: string | null }} level
 * @param {string[]} categories
 * @param {"home" | "added"} kind
 * @returns {import("../shared/contract.mjs").Wiki}
 */
export function describeWiki(level, categories, kind) {
  const projectModule = level.projectModule ?? path.basename(level.mountDir);
  return {
    id: hashRoot(level.root),
    kind,
    root: level.root,
    mountDir: level.mountDir,
    projectModule,
    ownership: level.ownership,
    label: level.label || prettify(projectModule),
    categories,
  };
}
