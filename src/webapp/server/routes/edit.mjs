import { EditDocRequest, ArchiveRequest, CreateDocRequest } from "../../shared/contract.mjs";
import { resolveWiki } from "../engine.mjs";
import { editDoc, setArchived, deleteDoc, createDoc } from "../edit.mjs";

/** @param {string | undefined} error @returns {number} */
function statusFor(error) {
  if (error === "write-gate-refused") return 403;
  if (error === "no-such-doc" || error === "no-such-category") return 404;
  if (error === "invalid-metadata" || error === "topology-unsupported") return 422;
  return 400;
}

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 */
export function registerEditRoutes(app, db) {
  const wikiFor = (/** @type {string} */ id) => resolveWiki(id, db.listPlaces());

  app.put("/api/wikis/:id/doc/*", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const docId = /** @type {{ "*": string }} */ (request.params)["*"];
    const wiki = await wikiFor(id);
    if (!wiki) {
      reply.code(404);
      return { ok: false, error: "no-such-wiki" };
    }
    const parsed = EditDocRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "invalid-request" };
    }
    const result = await editDoc(wiki.root, wiki.ownership, docId, parsed.data);
    if (!result.ok) reply.code(statusFor(result.error));
    return result;
  });

  app.post("/api/wikis/:id/archive/*", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const docId = /** @type {{ "*": string }} */ (request.params)["*"];
    const wiki = await wikiFor(id);
    if (!wiki) {
      reply.code(404);
      return { ok: false, error: "no-such-wiki" };
    }
    const parsed = ArchiveRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "invalid-request" };
    }
    const result = await setArchived(wiki.root, wiki.ownership, docId, parsed.data.archive);
    if (!result.ok) reply.code(statusFor(result.error));
    return result;
  });

  app.delete("/api/wikis/:id/doc/*", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const docId = /** @type {{ "*": string }} */ (request.params)["*"];
    const wiki = await wikiFor(id);
    if (!wiki) {
      reply.code(404);
      return { ok: false, error: "no-such-wiki" };
    }
    const result = await deleteDoc(wiki.root, wiki.ownership, docId);
    if (!result.ok) reply.code(statusFor(result.error));
    return result;
  });

  app.post("/api/wikis/:id/create", async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const wiki = await wikiFor(id);
    if (!wiki) {
      reply.code(404);
      return { ok: false, error: "no-such-wiki" };
    }
    const parsed = CreateDocRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "invalid-request" };
    }
    const result = await createDoc(wiki.root, wiki.ownership, parsed.data);
    if (!result.ok) reply.code(statusFor(result.error));
    return result;
  });
}
