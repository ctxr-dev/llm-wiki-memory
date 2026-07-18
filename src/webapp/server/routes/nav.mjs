import { listCategories, navChildren, docsFor } from "../nav.mjs";
import { resolveWikiRoot } from "../engine.mjs";

/** @param {unknown} value @returns {boolean} */
function truthy(value) {
  return value === "1" || value === "true";
}

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerNavRoutes(app, db) {
  const rootFor = (/** @type {string} */ id) => resolveWikiRoot(id, db.listPlaces());

  app.get("/api/wikis/:id/nav", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return { categories: await listCategories(root, db) };
  });

  app.get("/api/wikis/:id/nav/:category", async (request, reply) => {
    const { id, category } = /** @type {{ id: string, category: string }} */ (request.params);
    const query = /** @type {{ path?: string, archived?: string }} */ (request.query);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return navChildren(
      root,
      category,
      query.path ?? "",
      { showArchived: truthy(query.archived) },
      db,
    );
  });

  app.get("/api/wikis/:id/docs", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const query = /** @type {{ category?: string, prefix?: string, archived?: string }} */ (
      request.query
    );
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    const documents = await docsFor(root, {
      category: query.category,
      prefix: query.prefix,
      showArchived: truthy(query.archived),
    });
    return { documents };
  });
}
