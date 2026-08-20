import { SetPrefRequest } from "../../shared/contract.mjs";
import { resolveWikiRoot } from "../engine.mjs";
import { readDoc, relatedDocs } from "../doc.mjs";

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerDocRoutes(app, db) {
  const rootFor = (/** @type {string} */ id) => resolveWikiRoot(id, db.listPlaces());

  app.get("/api/wikis/:id/doc/*", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const docId = /** @type {{ "*": string }} */ (request.params)["*"];
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    const doc = await readDoc(root, docId);
    if (!doc) {
      reply.code(404);
      return { error: "no-such-doc" };
    }
    return doc;
  });

  app.get("/api/wikis/:id/related/*", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const docId = /** @type {{ "*": string }} */ (request.params)["*"];
    const query = /** @type {{ archived?: string }} */ (request.query);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    const includeArchived = query.archived === "1" || query.archived === "true";
    return { related: await relatedDocs(root, docId, { includeArchived }) };
  });

  app.get("/api/wikis/:id/prefs/:key", async (request, reply) => {
    const { id, key } = /** @type {{ id: string, key: string }} */ (request.params);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    return { value: db.getPref(`wiki:${id}`, key) };
  });

  app.put("/api/wikis/:id/prefs/:key", async (request, reply) => {
    const { id, key } = /** @type {{ id: string, key: string }} */ (request.params);
    const root = await rootFor(id);
    if (!root) {
      reply.code(404);
      return { error: "no-such-wiki" };
    }
    const parsed = SetPrefRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid-request" };
    }
    db.setPref(`wiki:${id}`, key, parsed.data.value);
    return { ok: true };
  });
}
