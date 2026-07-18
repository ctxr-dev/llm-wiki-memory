import path from "node:path";
import { AddWikiRequest } from "../../shared/contract.mjs";
import { listWikis, validateWikiFolder } from "../engine.mjs";
import { hashRoot } from "../wiki-describe.mjs";

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerWikiRoutes(app, db) {
  app.get("/api/wikis", async () => ({ wikis: await listWikis(db.listPlaces()) }));

  app.post("/api/wikis", async (request, reply) => {
    const parsed = AddWikiRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid-request" };
    }
    if (!path.isAbsolute(parsed.data.path)) {
      reply.code(400);
      return { error: "not-absolute" };
    }
    const wiki = await validateWikiFolder(parsed.data.path);
    if (!wiki) {
      reply.code(422);
      return { error: "not-a-wiki" };
    }
    if (wiki.kind === "home") {
      reply.code(409);
      return { error: "is-home" };
    }
    db.addPlace({ root: wiki.root, mountDir: wiki.mountDir, label: wiki.label });
    return { wiki };
  });

  app.delete("/api/wikis/:id", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const place = db.listPlaces().find((entry) => hashRoot(entry.root) === id);
    if (!place) {
      reply.code(404);
      return { error: "not-found" };
    }
    db.removePlace(place.root);
    return { ok: true };
  });
}
