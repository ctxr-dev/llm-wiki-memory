import fs from "node:fs";
import path from "node:path";
import { BRAIN_TARGET, OWNERSHIP } from "./enums.mjs";
import { ContextValidationError } from "./errors.mjs";

/** @typedef {import("../wiki-context.mjs").WikiContext} WikiContext */
/** @typedef {import("../wiki-context.mjs").WikiLevel} WikiLevel */

export const TARGET_KIND = Object.freeze({ DEFAULT: "default", BRAIN: "brain", LEVEL: "level" });

/**
 * @typedef {(typeof TARGET_KIND)[keyof typeof TARGET_KIND]} TargetKind
 * @typedef {{ kind: TargetKind, level: WikiLevel, requested: string | null }} ResolvedTarget
 */

// Symlink-resolved directory equality (macOS surfaces `/var` as `/private/var`,
// and the scanner realpaths some paths but not the brain's), falling back to a
// plain resolve when a side cannot be stat'd.
/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameDir(a, b) {
  if (!a || !b) return false;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * Parse a raw write/mutate `target` selector against a resolved context into a
 * typed ResolvedTarget. An empty target selects the write-default (brain) as
 * `default`; the literal "brain" selects the wiki-owned level; a root/mountDir
 * match selects that level; any other non-empty value throws (never a silent
 * brain fallback — R11). The returned `.level` is the SAME WikiLevel reference
 * the context holds, so callers can compare by identity.
 * @param {WikiContext | null | undefined} ctx
 * @param {string | null | undefined} raw
 * @returns {ResolvedTarget}
 */
export function parseTarget(ctx, raw) {
  if (!ctx || !Array.isArray(ctx.levels) || ctx.levels.length === 0) {
    throw new Error("parseTarget: no resolved wiki context");
  }
  const wanted = typeof raw === "string" ? raw.trim() : "";
  if (wanted === "") return { kind: TARGET_KIND.DEFAULT, level: ctx.writeDefault, requested: null };
  if (wanted === BRAIN_TARGET) {
    const level = ctx.levels.find((l) => l.ownership === OWNERSHIP.WIKI) || ctx.brain;
    return { kind: TARGET_KIND.BRAIN, level, requested: BRAIN_TARGET };
  }
  const level = ctx.levels.find((l) => sameDir(l.root, wanted) || sameDir(l.mountDir, wanted));
  if (level) return { kind: TARGET_KIND.LEVEL, level, requested: wanted };
  const accepted = [...ctx.levels.flatMap((l) => [l.root, l.mountDir]), BRAIN_TARGET];
  throw new ContextValidationError({
    field: "target",
    allowed: accepted,
    reason: `${JSON.stringify(raw)} is not one of the active context levels; pass a level's root or mount directory, or "${BRAIN_TARGET}"`,
  });
}
