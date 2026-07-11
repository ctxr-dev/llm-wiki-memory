/** @param {unknown} obj */
export function out(obj) {
  process.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)}\n`);
}
