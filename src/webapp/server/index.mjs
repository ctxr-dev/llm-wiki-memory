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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

/** @param {{ db?: import("./app-db.mjs").AppDb }} [opts] */
export function buildApp({ db } = {}) {
  const app = Fastify({ logger: false });
  const appDb = db ?? openAppDb();
  if (!db) app.addHook("onClose", async () => appDb.close());
  app.get("/api/health", async () => HealthSchema.parse(await memoryConfig([])));
  registerWikiRoutes(app, appDb);
  registerNavRoutes(app, appDb);
  registerDocRoutes(app, appDb);
  registerSearchRoutes(app, appDb);
  registerEditRoutes(app, appDb);
  if (fs.existsSync(DIST)) {
    app.register(fastifyStatic, { root: DIST });
    app.setNotFoundHandler((request, reply) => {
      if ((request.raw.url ?? "").startsWith("/api")) {
        reply.code(404).send({ error: "not-found" });
        return;
      }
      reply.type("text/html").sendFile("index.html");
    });
  }
  return app;
}

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
