import { resolveWikiRoot, listWikis } from "../engine.mjs";
import { searchWiki, searchAll, ask } from "../search.mjs";
import { startWarm } from "../warm-runner.mjs";
import { SearchFilterSchema } from "../../shared/contract.mjs";

/** @param {unknown} value @returns {string | undefined} */
function firstString(value) {
  const scalar = Array.isArray(value) ? value[0] : value;
  return typeof scalar === "string" ? scalar : undefined;
}

/** @param {unknown} value @returns {boolean} */
function truthy(value) {
  return value === "1" || value === "true";
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
    const opts = {
      filters: filtersFrom(query),
      category: query.category,
      includeArchived: truthy(query.archived),
    };
    if (query.scope === "all") {
      const wikis = await listWikis(db.listPlaces());
      return await searchAll(wikis, query.q ?? "", opts);
    }
    return await searchWiki(root, query.q ?? "", opts);
  });

  /**
   * The banner's remedy, made actionable. 202 + immediate return: a cold warm is ~90s of
   * duty-cycled slices, and this daemon already runs the same operation on a timer.
   */
  app.post("/api/wikis/:id/warm", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "unknown wiki" };
    }
    reply.code(202);
    return startWarm(root);
  });

  app.get("/api/wikis/:id/ask", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const query = /** @type {{ q?: string, archived?: string }} */ (request.query);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return ask(root, query.q ?? "", { includeArchived: truthy(query.archived) });
  });
}
