import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export const useWikis = () => useQuery({ queryKey: ["wikis"], queryFn: api.wikis });

export const useNav = (wikiId: string | null) =>
  useQuery({
    queryKey: ["nav", wikiId],
    queryFn: () => api.nav(wikiId as string),
    enabled: !!wikiId,
  });

export const useNavChildren = (
  wikiId: string | null,
  category: string,
  path: string,
  archived: boolean,
) =>
  useQuery({
    queryKey: ["navChildren", wikiId, category, path, archived],
    queryFn: () => api.navChildren(wikiId as string, category, path, archived),
    enabled: !!wikiId && !!category,
  });

export const useDoc = (wikiId: string | null, docId: string | null) =>
  useQuery({
    queryKey: ["doc", wikiId, docId],
    queryFn: () => api.doc(wikiId as string, docId as string),
    enabled: !!wikiId && !!docId,
  });

export const useRelated = (wikiId: string | null, docId: string | null) =>
  useQuery({
    queryKey: ["related", wikiId, docId],
    queryFn: () => api.related(wikiId as string, docId as string),
    enabled: !!wikiId && !!docId,
  });
