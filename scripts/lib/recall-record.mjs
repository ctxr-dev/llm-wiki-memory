// The pure SearchHit -> RecallRecord projection: what a recall response exposes to a client, and
// nothing else. Split out of recall.mjs, which owns the ladder and the write path — the same
// pure-half split as embed-chunk-text.mjs.

/** @typedef {import("./types.mjs").RecallRecord} RecallRecord */
/** @typedef {import("./types.mjs").SearchHit} SearchHit */

/**
 * @param {SearchHit & { kind?: string }} r
 * @returns {RecallRecord}
 */
export function toRecallRecord(r) {
  return /** @type {RecallRecord} */ ({
    kind: r.kind,
    datasetId: r.datasetId,
    documentName: r.documentName,
    score: r.score,
    priority: r.priority,
    content: r.content,
    // Glance fields ride along only when the caller asked for the frontmatter
    // view (withGlance); otherwise they are absent and the shape is unchanged.
    ...(r.brief !== undefined ? { brief: r.brief } : {}),
    ...(r.type !== undefined ? { type: r.type } : {}),
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.progress !== undefined ? { progress: r.progress } : {}),
    ...(r.tags !== undefined ? { tags: r.tags } : {}),
  });
}
