import fs from "node:fs";
import path from "node:path";

/** @param {string} p @returns {string} */
export function realpathOr(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** @param {string} p @returns {string} */
export function samePathKey(p) {
  const real = realpathOr(p);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** @param {string} a @param {string} b @returns {boolean} */
export function samePath(a, b) {
  return samePathKey(a) === samePathKey(b);
}

/** @param {string} root @param {string} target @returns {boolean} */
export function isWithin(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}
