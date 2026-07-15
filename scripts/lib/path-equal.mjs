import fs from "node:fs";
import path from "node:path";

/** @param {string} p @returns {string} */
function canon(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }
}

/** @param {string} a @param {string} b @returns {boolean} */
export function samePath(a, b) {
  const ra = canon(a);
  const rb = canon(b);
  if (ra === rb) return true;
  if (process.platform === "win32") {
    return path.resolve(ra).toLowerCase() === path.resolve(rb).toLowerCase();
  }
  return false;
}
