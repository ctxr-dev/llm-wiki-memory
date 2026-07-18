import { z } from "zod";

export const LevelSchema = z.object({
  root: z.string(),
  mountDir: z.string(),
  projectModule: z.string(),
  ownership: z.string(),
  depth: z.number(),
});

export const HealthSchema = z.object({
  ok: z.literal(true),
  wikiRoot: z.string(),
  embedBackend: z.string(),
  defaultProjectModule: z.string(),
  levels: z.array(LevelSchema),
  categories: z.array(z.string()),
});

export const WikiSchema = z.object({
  id: z.string(),
  kind: z.enum(["home", "added"]),
  root: z.string(),
  mountDir: z.string(),
  projectModule: z.string(),
  ownership: z.string(),
  label: z.string(),
  categories: z.array(z.string()),
});

export const WikiListSchema = z.object({ wikis: z.array(WikiSchema) });

export const AddWikiRequest = z.object({ path: z.string().min(1) }).strict();

export const NavCategorySchema = z.object({
  category: z.string(),
  label: z.string(),
  facets: z.array(z.string()),
  count: z.number(),
  hasTopology: z.boolean(),
  isFull: z.boolean(),
});

export const NavCategoriesSchema = z.object({ categories: z.array(NavCategorySchema) });

export const NavDirSchema = z.object({
  name: z.string(),
  label: z.string(),
  count: z.number(),
});

export const DocEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
});

export const NavChildrenSchema = z.object({
  category: z.string(),
  path: z.string(),
  dirs: z.array(NavDirSchema),
  docs: z.array(DocEntrySchema),
});

export const DocListSchema = z.object({ documents: z.array(DocEntrySchema) });

/** @typedef {import("zod").infer<typeof HealthSchema>} Health */
/** @typedef {import("zod").infer<typeof LevelSchema>} Level */
/** @typedef {import("zod").infer<typeof WikiSchema>} Wiki */
/** @typedef {import("zod").infer<typeof AddWikiRequest>} AddWiki */
/** @typedef {import("zod").infer<typeof NavCategorySchema>} NavCategory */
/** @typedef {import("zod").infer<typeof NavChildrenSchema>} NavChildren */
/** @typedef {import("zod").infer<typeof DocEntrySchema>} DocEntry */
