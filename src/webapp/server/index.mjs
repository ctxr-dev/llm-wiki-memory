import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { HealthSchema } from "../shared/contract.mjs";
import { memoryConfig } from "./engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

export function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/api/health", async () => HealthSchema.parse(await memoryConfig([])));
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
