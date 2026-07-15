import fs from "node:fs";

const FS_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST", "ENOTEMPTY"]);

// Windows transiently fails file mutations (rename/rm/rmdir over a path AV, the
// Search indexer, or a concurrent reader momentarily holds open); a valid POSIX
// op never raises these codes, so this is a no-op there.
/**
 * @template T
 * @param {() => T} op
 * @returns {T}
 */
export function withFsRetry(op) {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code;
      if (attempt >= 10 || !code || !FS_LOCK_CODES.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
    }
  }
}

/** @param {string} tmp @param {string} dest @param {(a: string, b: string) => void} [rename] @returns {void} */
export function renameWithRetry(tmp, dest, rename = fs.renameSync) {
  withFsRetry(() => rename(tmp, dest));
}
