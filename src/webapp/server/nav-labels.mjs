import { prettify } from "./wiki-describe.mjs";

const SENTINELS = new Set(["unscoped", "unknown", "untyped", "general", "misc"]);

/** @param {string} name @returns {string} */
export function relabel(name) {
  return SENTINELS.has(name) ? "Unspecified" : prettify(name);
}

/** @param {string} category @returns {string} */
export function categoryLabel(category) {
  return prettify(category);
}
