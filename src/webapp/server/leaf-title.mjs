/** @param {{ focus?: unknown }} data @param {string} fallback @returns {string} */
export function leafTitle(data, fallback) {
  return typeof data.focus === "string" && data.focus ? data.focus : fallback;
}

/**
 * @param {{ readLeaf: (abs: string) => { data: { focus?: unknown } } }} core
 * @param {{ toAbs: (id: string) => string }} identity
 * @param {string} id @param {string} fallback @returns {string}
 */
export function titleForId(core, identity, id, fallback) {
  try {
    return leafTitle(core.readLeaf(identity.toAbs(id)).data, fallback);
  } catch {
    return fallback;
  }
}

/** @param {any} data @returns {import("../shared/contract.mjs").LeafSummary} */
export function summaryFromData(data) {
  const mem = (data && typeof data.memory === "object" && data.memory) || {};
  const rawTags = [
    ...(Array.isArray(data?.tags) ? data.tags : []),
    ...String(mem.tags || "").split(","),
  ]
    .map((tag) => String(tag).trim())
    .filter(Boolean);
  /** @type {import("../shared/contract.mjs").LeafSummary} */
  const summary = {};
  if (typeof mem.atom_type === "string" && mem.atom_type) summary.atomType = mem.atom_type;
  if (typeof mem.area === "string" && mem.area) summary.area = mem.area;
  if (typeof mem.priority === "string" && mem.priority) summary.priority = mem.priority;
  if (typeof data?.updated === "string" && data.updated) summary.updated = data.updated;
  if (rawTags.length) summary.tags = [...new Set(rawTags)];
  return summary;
}

/**
 * @param {{ readLeaf: (abs: string) => { data: { focus?: unknown } } }} core
 * @param {{ toAbs: (id: string) => string }} identity
 * @param {string} id @param {string} fallback
 * @returns {{ title: string, summary: import("../shared/contract.mjs").LeafSummary }}
 */
export function cardForId(core, identity, id, fallback) {
  try {
    const { data } = core.readLeaf(identity.toAbs(id));
    return { title: leafTitle(data, fallback), summary: summaryFromData(data) };
  } catch {
    return { title: fallback, summary: {} };
  }
}
