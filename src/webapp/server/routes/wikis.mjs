import path from "node:path";
import { AddWikiRequest } from "../../shared/contract.mjs";
import { listWikis, validateWikiFolder } from "../engine.mjs";
import { hashRoot } from "../wiki-describe.mjs";
import { pickFolderNative } from "../pick-folder.mjs";

/**
 * A native folder dialog is a machine-local side effect, so the endpoint only
 * honours same-origin requests: a cross-origin page must not be able to pop OS
 * dialogs on the user's desktop. An absent Origin (server-side callers, tests) is
 * treated as same-origin.
 * @param {import("fastify").FastifyRequest} request
 * @returns {boolean}
 */
function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {import("../app-db.mjs").AppDb} db
 * @param {{ pickFolder?: () => Promise<string> }} [deps]
 */
export function registerWikiRoutes(app, db, { pickFolder = pickFolderNative } = {}) {
  let pickInFlight = false;

  app.get("/api/wikis", async () => ({ wikis: await listWikis(db.listPlaces()) }));

  app.post("/api/pick-folder", async (request, reply) => {
    if (!isSameOrigin(request)) {
      reply.code(403);
      return { error: "forbidden" };
    }
    if (pickInFlight) {
      reply.code(409);
      return { error: "busy" };
    }
    pickInFlight = true;
    try {
      return { path: await pickFolder() };
    } catch (error) {
      if (String(/** @type {Error} */ (error)?.message) === "unsupported") {
        reply.code(501);
        return { error: "unsupported" };
      }
      reply.code(500);
      return { error: "pick-failed" };
    } finally {
      pickInFlight = false;
    }
  });

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
