import type { Wiki } from "./api";
import { formatRef, resolveRef, type ResolvedRef } from "./refs";

export function refToHash(ref: string): string {
  return `#${encodeURI(ref)}`;
}

export function hashToRef(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

export function desiredHash(wiki: Wiki | undefined, docId: string | null): string {
  return wiki && docId ? refToHash(formatRef(wiki, docId)) : "";
}

export function resolveHash(wikis: Wiki[], hash: string): ResolvedRef | null {
  const ref = hashToRef(hash);
  return ref ? resolveRef(wikis, ref) : null;
}

export type RestorePlan = { tabs: string[]; active: string | null };

export function planRestore(restored: string[], pendingDocId: string | null): RestorePlan {
  if (pendingDocId) {
    const tabs = restored.includes(pendingDocId) ? restored : [...restored, pendingDocId];
    return { tabs, active: pendingDocId };
  }
  return { tabs: restored, active: restored[0] ?? null };
}
