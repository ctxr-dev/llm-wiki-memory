import { z } from "zod";
import { PrioritySchema } from "../scripts/lib/context/enums.mjs";

const FilterSchema = z
  .object({
    atom_type: z.string().trim().min(1).optional(),
    project_module: z.string().trim().min(1).optional(),
    area: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional(),
    task_type: z.string().trim().min(1).optional(),
    error_pattern: z.string().trim().min(1).optional(),
    tags: z.string().trim().min(1).optional(),
  })
  .partial();

const MetadataSchema = z
  .object({
    atom_type: z.string().optional(),
    tags: z.string().optional(),
    project_module: z.string().optional(),
    area: z.string().optional(),
    language: z.string().optional(),
    task_type: z.string().optional(),
    error_pattern: z.string().optional(),
    // Apply-strength (optional; the engine fills a rubric default by atom_type
    // when absent). P0 is scarce: a non-gated write requesting P0 without an
    // explicit user/maintenance consent signal is coerced to P1 (see
    // guardScarcePriority).
    priority: PrioritySchema.optional(),
  })
  .partial();

export { FilterSchema, MetadataSchema };
