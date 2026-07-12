import { z } from "zod";
import { ATOM_TYPES_LIST, TASK_TYPES_LIST, PRIORITY_VALUES } from "../datasets.mjs";
import { DEFAULT_CATEGORIES, SELF_IMPROVEMENT, KNOWLEDGE } from "../wiki-layout-parse.mjs";

export {
  ATOM_TYPES_LIST,
  TASK_TYPES_LIST,
  PRIORITY_VALUES,
  DEFAULT_CATEGORIES,
  SELF_IMPROVEMENT,
  KNOWLEDGE,
};

export const OWNERSHIP = Object.freeze({ REPO: "repo", WIKI: "wiki" });
export const OWNERSHIP_VALUES = Object.freeze([OWNERSHIP.REPO, OWNERSHIP.WIKI]);

export const BRAIN_TARGET = "brain";

const SECTIONS = Object.freeze({ FRONTMATTER: "frontmatter", BODY: "body" });
export const SECTION_VALUES = Object.freeze([SECTIONS.FRONTMATTER, SECTIONS.BODY]);

const SUPERSEDES_ACTIONS = Object.freeze({ DISABLE: "disable", DELETE: "delete" });
export const SUPERSEDES_ACTION_VALUES = Object.freeze([
  SUPERSEDES_ACTIONS.DISABLE,
  SUPERSEDES_ACTIONS.DELETE,
]);

export const AUDIT_CLASSES = Object.freeze({
  DUPLICATE_ERROR_PATTERN: "duplicate-error-pattern",
  MISSING_METADATA: "missing-metadata",
});
export const AUDIT_CLASS_VALUES = Object.freeze([
  AUDIT_CLASSES.DUPLICATE_ERROR_PATTERN,
  AUDIT_CLASSES.MISSING_METADATA,
]);

export const KIND = Object.freeze({ PLAN: "plan", KNOWLEDGE: "knowledge" });
export const PLAN_SUFFIX = ".plan.md";

export const DEFAULT_TOPOLOGY_CATEGORY = "issues";

export const MCP_ACTOR = "mcp";
export const MCP_OPS = Object.freeze({
  SAVE_LESSON: "mcp-save-lesson",
  SAVE: "mcp-save",
  WRITE_MEMORY: "mcp-write-memory",
  DISABLE: "mcp-disable",
  ENABLE: "mcp-enable",
  DELETE: "mcp-delete",
  MOVE: "mcp-move",
});

/**
 * @param {readonly string[]} values
 * @returns {[string, ...string[]]}
 */
function asEnumTuple(values) {
  return /** @type {[string, ...string[]]} */ (/** @type {readonly string[]} */ (values));
}

export const OwnershipSchema = z.enum(asEnumTuple(OWNERSHIP_VALUES));
export const PrioritySchema = z.enum(asEnumTuple(PRIORITY_VALUES));
export const SectionSchema = z.enum(asEnumTuple(SECTION_VALUES));
export const SupersedesActionSchema = z.enum(asEnumTuple(SUPERSEDES_ACTION_VALUES));
export const AuditClassSchema = z.enum(asEnumTuple(AUDIT_CLASS_VALUES));
