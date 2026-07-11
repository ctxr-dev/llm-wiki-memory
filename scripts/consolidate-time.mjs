// Clock helpers. All consolidate passes take an injectable `now` (Date |
// ISO string | undefined) so frozen-clock tests are byte-deterministic.

/**
 * Injectable clock input threaded through every consolidate pass.
 * @typedef {Date | string | undefined} NowInput
 */

/**
 * @param {NowInput} now
 * @returns {string}
 */
export function toIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

/**
 * @param {NowInput} now
 * @returns {number}
 */
export function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string" && now) {
    const t = Date.parse(now);
    return Number.isFinite(t) ? t : Date.now();
  }
  return Date.now();
}

/**
 * @param {string | number | null | undefined} isoOrEpoch
 * @param {NowInput} now
 * @returns {number}
 */
export function ageInDays(isoOrEpoch, now) {
  if (!isoOrEpoch) return Infinity;
  const t = typeof isoOrEpoch === "string" ? Date.parse(isoOrEpoch) : Number(isoOrEpoch);
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs(now) - t) / (1000 * 60 * 60 * 24);
}

/**
 * @param {string | number | null | undefined} isoOrEpoch
 * @param {NowInput} now
 * @returns {number}
 */
export function ageInMonths(isoOrEpoch, now) {
  return ageInDays(isoOrEpoch, now) / 30.4375;
}
