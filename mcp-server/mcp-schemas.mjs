import { z } from "zod";
import { PrioritySchema } from "../scripts/lib/context/enums.mjs";

// `subject` is the layout's semantic placement axis (default layout: a `kind:path`
// facet nesting knowledge/self_improvement/plans/investigations by broad->narrow
// slugs). It is a first-class MemoryMetadata field (string | string[]), so the
// strict boundary must admit it — otherwise a subject-carrying write/filter, which
// the layout places on, would be rejected at the wire.
const SubjectSchema = z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]);

const FilterSchema = z
  .object({
    atom_type: z.string().trim().min(1).optional(),
    project_module: z.string().trim().min(1).optional(),
    area: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional(),
    task_type: z.string().trim().min(1).optional(),
    error_pattern: z.string().trim().min(1).optional(),
    tags: z.string().trim().min(1).optional(),
    subject: SubjectSchema.optional(),
  })
  .partial()
  .strict();

const MetadataSchema = z
  .object({
    atom_type: z.string().optional(),
    tags: z.string().optional(),
    project_module: z.string().optional(),
    area: z.string().optional(),
    language: z.string().optional(),
    task_type: z.string().optional(),
    error_pattern: z.string().optional(),
    subject: SubjectSchema.optional(),
    // Apply-strength (optional; the engine fills a rubric default by atom_type
    // when absent). P0 is scarce: a non-gated write requesting P0 without an
    // explicit user/maintenance consent signal is coerced to P1 (see
    // guardScarcePriority).
    priority: PrioritySchema.optional(),
  })
  .partial()
  .strict();

export { FilterSchema, MetadataSchema };
