/**
 * @param {unknown} originUrl
 * @returns {string | null}
 */
export function canonicalRepoId(originUrl) {
  if (typeof originUrl !== "string") return null;
  let s = originUrl.trim().toLowerCase();
  if (s === "") return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^@/]+@/, "");
  const slash = s.indexOf("/");
  const colon = s.indexOf(":");
  if (slash === -1 && colon === -1) return null;
  let path;
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    const afterColon = s.slice(colon + 1);
    const port = afterColon.match(/^\d+\//);
    path = port ? afterColon.slice(port[0].length) : afterColon;
  } else {
    path = s.slice(slash + 1);
  }
  path = path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  if (!path.includes("/")) return null;
  return path;
}
