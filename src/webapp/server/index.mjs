import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { HealthSchema } from "../shared/contract.mjs";
import { memoryConfig } from "./engine.mjs";
import { openAppDb } from "./app-db.mjs";
import { registerWikiRoutes } from "./routes/wikis.mjs";
import { registerNavRoutes } from "./routes/nav.mjs";
import { registerDocRoutes } from "./routes/doc.mjs";
import { registerSearchRoutes } from "./routes/search.mjs";
import { registerEditRoutes } from "./routes/edit.mjs";
import { registerBoardRoutes } from "./routes/boards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

/**
 * @param {{ db?: import("./app-db.mjs").AppDb, pickFolder?: () => Promise<string> }} [opts]
 */
export function buildApp({ db, pickFolder } = {}) {
  const app = Fastify({ logger: false });
  const appDb = db ?? openAppDb();
  if (!db) app.addHook("onClose", async () => appDb.close());
  app.get("/api/health", async () => HealthSchema.parse(await memoryConfig([])));
  registerWikiRoutes(app, appDb, { pickFolder });
  registerNavRoutes(app, appDb);
  registerDocRoutes(app, appDb);
  registerSearchRoutes(app, appDb);
  registerEditRoutes(app, appDb);
  registerBoardRoutes(app, appDb);
  if (fs.existsSync(path.join(DIST, "index.html"))) {
    app.register(fastifyStatic, { root: DIST });
    app.setNotFoundHandler((request, reply) => {
      if ((request.raw.url ?? "").startsWith("/api")) {
        reply.code(404).send({ error: "not-found" });
        return;
      }
      reply.type("text/html").sendFile("index.html");
    });
  } else {
    app.get("/", async (_request, reply) => {
      reply.code(503).type("text/html").send(NOT_BUILT_HTML);
    });
  }
  return app;
}

const NOT_BUILT_HTML =
  "<!doctype html><meta charset=utf-8><title>llm-wiki-memory</title>" +
  '<body style="font-family:system-ui;padding:3rem;color:#334155">' +
  "<h1>Web client not built</h1><p>Run <code>npm run -w src/webapp build</code> " +
  "in the engine repo, then <code>llm-wiki-webapp restart</code>.</p></body>";

const PORT = Number(process.env.PORT || 4319);
const HOST = process.env.LWM_WEBAPP_HOST || "127.0.0.1";

export async function start() {
  const app = buildApp();
  await app.listen({ port: PORT, host: HOST });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
