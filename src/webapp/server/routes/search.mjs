import { resolveWikiRoot, listWikis } from "../engine.mjs";
import { searchWiki, searchAll, ask } from "../search.mjs";

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerSearchRoutes(app, db) {
  const rootFor = (/** @type {string} */ id) => resolveWikiRoot(id, db.listPlaces());

  app.get("/api/wikis/:id/search", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const query = /** @type {{ q?: string, scope?: string }} */ (request.query);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    if (query.scope === "all") {
      const wikis = await listWikis(db.listPlaces());
      return { results: await searchAll(wikis, query.q ?? "") };
    }
    return { results: await searchWiki(root, query.q ?? "") };
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
