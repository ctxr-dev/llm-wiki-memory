import { resolveWikiRoot } from "../engine.mjs";
import { plansBoard, issuesBoard } from "../boards.mjs";

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerBoardRoutes(app, db) {
  const rootFor = (/** @type {string} */ id) => resolveWikiRoot(id, db.listPlaces());

  app.get("/api/wikis/:id/plans", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return plansBoard(root);
  });

  app.get("/api/wikis/:id/issues", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return issuesBoard(root);
  });
}
