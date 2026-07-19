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

export const DocViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  body: z.string(),
  frontmatter: z.record(z.unknown()),
  memory: z.record(z.unknown()),
  active: z.boolean(),
});

export const RelatedEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  score: z.number(),
});

export const RelatedListSchema = z.object({ related: z.array(RelatedEntrySchema) });

export const PrefValueSchema = z.object({ value: z.string().nullable() });

export const SetPrefRequest = z.object({ value: z.string() }).strict();

export const SearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  score: z.number(),
  snippet: z.string(),
  wikiId: z.string().optional(),
  wikiLabel: z.string().optional(),
});

export const SearchResultsSchema = z.object({ results: z.array(SearchResultSchema) });

export const AskAnswerSchema = z
  .object({ id: z.string(), name: z.string(), category: z.string(), content: z.string() })
  .nullable();

export const AskResponseSchema = z.object({
  answer: AskAnswerSchema,
  sources: z.array(SearchResultSchema),
});

export const MetaInputSchema = z.record(z.unknown());

export const EditDocRequest = z
  .object({
    body: z.string().optional(),
    memory: MetaInputSchema.optional(),
    userRequested: z.boolean().optional(),
  })
  .strict();

export const ArchiveRequest = z.object({ archive: z.boolean() }).strict();

export const CreateDocRequest = z
  .object({
    category: z.string(),
    name: z.string().min(1),
    title: z.string().optional(),
    body: z.string().optional(),
    memory: MetaInputSchema.optional(),
    userRequested: z.boolean().optional(),
  })
  .strict();

export const EditResultSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  relocatedFrom: z.string().nullable().optional(),
  status: z.string().optional(),
  shared: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export const PlanCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  status: z.string(),
  progress: z.string(),
  active: z.boolean(),
});

export const PlansBoardSchema = z.object({
  columns: z.array(z.object({ key: z.string(), cards: z.array(PlanCardSchema) })),
});

export const IssueCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  tracker: z.string(),
  prefix: z.string(),
  number: z.string(),
  lifecycle: z.string().optional(),
  slug: z.string().optional(),
});

export const IssuesBoardSchema = z.object({
  hasIssues: z.boolean(),
  columns: z.array(z.object({ key: z.string(), cards: z.array(IssueCardSchema) })),
});

/** @typedef {import("zod").infer<typeof HealthSchema>} Health */
/** @typedef {import("zod").infer<typeof LevelSchema>} Level */
/** @typedef {import("zod").infer<typeof WikiSchema>} Wiki */
/** @typedef {import("zod").infer<typeof AddWikiRequest>} AddWiki */
/** @typedef {import("zod").infer<typeof NavCategorySchema>} NavCategory */
/** @typedef {import("zod").infer<typeof NavChildrenSchema>} NavChildren */
/** @typedef {import("zod").infer<typeof DocEntrySchema>} DocEntry */
/** @typedef {import("zod").infer<typeof DocViewSchema>} DocView */
/** @typedef {import("zod").infer<typeof RelatedEntrySchema>} RelatedEntry */
/** @typedef {import("zod").infer<typeof SearchResultSchema>} SearchResult */
/** @typedef {import("zod").infer<typeof AskResponseSchema>} AskResponse */
/** @typedef {import("zod").infer<typeof EditResultSchema>} EditResult */
/** @typedef {import("zod").infer<typeof PlansBoardSchema>} PlansBoard */
/** @typedef {import("zod").infer<typeof PlanCardSchema>} PlanCard */
/** @typedef {import("zod").infer<typeof IssuesBoardSchema>} IssuesBoard */
/** @typedef {import("zod").infer<typeof IssueCardSchema>} IssueCard */
