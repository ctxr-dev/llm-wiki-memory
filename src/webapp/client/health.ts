import { z } from "zod";
import { HealthSchema } from "../shared/contract.mjs";

export type Health = z.infer<typeof HealthSchema>;

export async function fetchHealth(): Promise<Health> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`health request failed: ${response.status}`);
  }
  return HealthSchema.parse(await response.json());
}
