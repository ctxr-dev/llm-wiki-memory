import { resolveWikiRoot, listWikis } from "../engine.mjs";
import { searchWiki, searchAll, ask } from "../search.mjs";
import { SearchFilterSchema } from "../../shared/contract.mjs";

/** @param {unknown} value @returns {string | undefined} */
function firstString(value) {
  const scalar = Array.isArray(value) ? value[0] : value;
  return typeof scalar === "string" ? scalar : undefined;
}

/** @param {Record<string, unknown>} query */
function filtersFrom(query) {
  const parsed = SearchFilterSchema.safeParse({
    area: firstString(query.area),
    atom_type: firstString(query.atom_type),
    task_type: firstString(query.task_type),
    subject: firstString(query.subject),
    tags: firstString(query.tags),
    language: firstString(query.language),
    priority: firstString(query.priority),
  });
  const filters = parsed.success ? parsed.data : {};
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value != null && value !== ""),
  );
}

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerSearchRoutes(app, db) {
  const rootFor = (/** @type {string} */ id) => resolveWikiRoot(id, db.listPlaces());

  app.get("/api/wikis/:id/search", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const query = /** @type {Record<string, string | undefined>} */ (request.query);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    const opts = { filters: filtersFrom(query), category: query.category };
    if (query.scope === "all") {
      const wikis = await listWikis(db.listPlaces());
      return { results: await searchAll(wikis, query.q ?? "", opts) };
    }
    return { results: await searchWiki(root, query.q ?? "", opts) };
  });

  app.get("/api/wikis/:id/ask", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const query = /** @type {{ q?: string }} */ (request.query);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return ask(root, query.q ?? "");
  });
}
