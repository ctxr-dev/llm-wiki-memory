import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomic } from "./atomic-write.mjs";

export const MANIFEST_VERSION = 1;

/**
 * @typedef {{ kind: "file", path: string, sha256: string }
 *   | { kind: "block", path: string, marker: string }
 *   | { kind: "config", path: string, key: string }} InstallArtifact
 */
/** @typedef {{ version: number, workspaceDir: string, artifacts: InstallArtifact[] }} InstallManifest */

/** @param {string} workspaceDir @returns {string} */
export function manifestPath(workspaceDir) {
  return path.join(workspaceDir, ".llm-wiki-memory", "state", ".install-manifest.json");
}

/** @param {string} content @returns {string} */
export function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** @param {InstallArtifact} a @returns {string} */
function artifactKey(a) {
  const detail = a.kind === "file" ? a.sha256 : a.kind === "block" ? a.marker : a.key;
  return `${a.path}\0${a.kind}\0${detail}`;
}

/** @param {InstallArtifact[]} artifacts @returns {InstallArtifact[]} */
function sortArtifacts(artifacts) {
  return [...artifacts].sort((x, y) =>
    artifactKey(x) < artifactKey(y) ? -1 : artifactKey(x) > artifactKey(y) ? 1 : 0,
  );
}

/** @param {string} workspaceDir @returns {InstallManifest | null} */
export function readManifest(workspaceDir) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(workspaceDir), "utf8"));
    if (m && m.version === MANIFEST_VERSION && Array.isArray(m.artifacts)) return m;
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the install manifest deterministically (artifacts sorted by a stable key),
 * so a re-install with the same artifact set produces a byte-identical file.
 * @param {string} workspaceDir
 * @param {InstallArtifact[]} artifacts
 * @returns {InstallManifest}
 */
export function writeManifest(workspaceDir, artifacts) {
  const p = manifestPath(workspaceDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  /** @type {InstallManifest} */
  const manifest = {
    version: MANIFEST_VERSION,
    workspaceDir: path.resolve(workspaceDir),
    artifacts: sortArtifacts(artifacts),
  };
  writeFileAtomic(p, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
