import { z } from "zod";
import {
  WikiListSchema,
  NavCategoriesSchema,
  NavChildrenSchema,
  DocListSchema,
  DocViewSchema,
  RelatedListSchema,
  PrefValueSchema,
} from "../shared/contract.mjs";

export type Wiki = z.infer<typeof WikiListSchema>["wikis"][number];
export type NavCategory = z.infer<typeof NavCategoriesSchema>["categories"][number];
export type NavChildren = z.infer<typeof NavChildrenSchema>;
export type DocEntry = z.infer<typeof DocListSchema>["documents"][number];
export type DocView = z.infer<typeof DocViewSchema>;
export type RelatedEntry = z.infer<typeof RelatedListSchema>["related"][number];

async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  return schema.parse(await response.json());
}

const flag = (archived: boolean) => (archived ? "&archived=1" : "");

export const api = {
  wikis: () => getJson("/api/wikis", WikiListSchema).then((r) => r.wikis),
  nav: (id: string) =>
    getJson(`/api/wikis/${id}/nav`, NavCategoriesSchema).then((r) => r.categories),
  navChildren: (id: string, category: string, path: string, archived: boolean) =>
    getJson(
      `/api/wikis/${id}/nav/${category}?path=${encodeURIComponent(path)}${flag(archived)}`,
      NavChildrenSchema,
    ),
  doc: (id: string, docId: string) => getJson(`/api/wikis/${id}/doc/${docId}`, DocViewSchema),
  related: (id: string, docId: string) =>
    getJson(`/api/wikis/${id}/related/${docId}`, RelatedListSchema).then((r) => r.related),
  getPref: (id: string, key: string) =>
    getJson(`/api/wikis/${id}/prefs/${key}`, PrefValueSchema).then((r) => r.value),
  setPref: (id: string, key: string, value: string) =>
    fetch(`/api/wikis/${id}/prefs/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }),
};
