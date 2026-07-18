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

/** @typedef {import("zod").infer<typeof HealthSchema>} Health */
/** @typedef {import("zod").infer<typeof LevelSchema>} Level */
/** @typedef {import("zod").infer<typeof WikiSchema>} Wiki */
/** @typedef {import("zod").infer<typeof AddWikiRequest>} AddWiki */
