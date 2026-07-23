import { prettify } from "./wiki-describe.mjs";

const SENTINELS = new Set(["unscoped", "unknown", "untyped", "general", "misc"]);

/** @param {string} name @returns {boolean} */
export function isSentinel(name) {
  return SENTINELS.has(name.toLowerCase());
}

/** @param {string} name @returns {string} */
export function relabel(name) {
  return isSentinel(name) ? "Unspecified" : prettify(name);
}

/** @param {string} category @returns {string} */
export function categoryLabel(category) {
  return prettify(category);
}

/** @param {string} id @returns {string} */
export function locationOf(id) {
  const segments = id.split("/").slice(0, -1);
  /** @type {string[]} */
  const labels = [];
  segments.forEach((segment, index) => {
    if (index === 0) labels.push(categoryLabel(segment));
    else if (!isSentinel(segment) && !/^\d+$/.test(segment)) labels.push(prettify(segment));
  });
  return labels.join(" › ");
}
