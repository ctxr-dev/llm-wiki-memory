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

/** @typedef {import("zod").infer<typeof HealthSchema>} Health */
/** @typedef {import("zod").infer<typeof LevelSchema>} Level */
