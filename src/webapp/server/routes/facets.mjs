import { facetsFor } from "../facets.mjs";
import { resolveWikiRoot } from "../engine.mjs";

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerFacetsRoutes(app, db) {
  const rootFor = (/** @type {string} */ id) => resolveWikiRoot(id, db.listPlaces());

  app.get("/api/wikis/:id/facets", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return facetsFor(root);
  });
}
