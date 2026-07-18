import { z } from "zod";
import {
  WikiListSchema,
  NavCategoriesSchema,
  NavChildrenSchema,
  DocListSchema,
  DocViewSchema,
  RelatedListSchema,
  PrefValueSchema,
  SearchResultsSchema,
  AskResponseSchema,
  EditResultSchema,
} from "../shared/contract.mjs";

export type Wiki = z.infer<typeof WikiListSchema>["wikis"][number];
export type NavCategory = z.infer<typeof NavCategoriesSchema>["categories"][number];
export type NavChildren = z.infer<typeof NavChildrenSchema>;
export type DocEntry = z.infer<typeof DocListSchema>["documents"][number];
export type DocView = z.infer<typeof DocViewSchema>;
export type RelatedEntry = z.infer<typeof RelatedListSchema>["related"][number];
export type SearchResult = z.infer<typeof SearchResultsSchema>["results"][number];
export type AskResponse = z.infer<typeof AskResponseSchema>;
export type EditResult = z.infer<typeof EditResultSchema>;
export type MemoryInput = Record<string, unknown>;
export type CreateInput = {
  category: string;
  name: string;
  title?: string;
  body?: string;
  memory?: MemoryInput;
  userRequested?: boolean;
};

async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  return schema.parse(await response.json());
}

async function sendJson<T>(
  url: string,
  method: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  search: (id: string, q: string, scope: "wiki" | "all") =>
    getJson(
      `/api/wikis/${id}/search?q=${encodeURIComponent(q)}${scope === "all" ? "&scope=all" : ""}`,
      SearchResultsSchema,
    ).then((r) => r.results),
  ask: (id: string, q: string) =>
    getJson(`/api/wikis/${id}/ask?q=${encodeURIComponent(q)}`, AskResponseSchema),
  editDoc: (
    id: string,
    docId: string,
    payload: { body?: string; memory?: MemoryInput; userRequested?: boolean },
  ) => sendJson(`/api/wikis/${id}/doc/${docId}`, "PUT", payload, EditResultSchema),
  archiveDoc: (id: string, docId: string, archive: boolean) =>
    sendJson(`/api/wikis/${id}/archive/${docId}`, "POST", { archive }, EditResultSchema),
  createDoc: (id: string, payload: CreateInput) =>
    sendJson(`/api/wikis/${id}/create`, "POST", payload, EditResultSchema),
  getPref: (id: string, key: string) =>
    getJson(`/api/wikis/${id}/prefs/${key}`, PrefValueSchema).then((r) => r.value),
  setPref: (id: string, key: string, value: string) =>
    fetch(`/api/wikis/${id}/prefs/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }),
};
