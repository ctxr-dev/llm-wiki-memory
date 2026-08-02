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
import { registerFacetsRoutes } from "./routes/facets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const WARM_START_DELAY_MS = 15_000;
/**
 * The timer only OFFERS a warm; embed.warmIntervalMinutes decides whether the offer
 * is due, so ticking more often than the interval costs one cheap stamp read.
 */
const WARM_TICK_MS = 5 * 60_000;

/**
 * Warms the home wiki's embedding caches inside THIS daemon, gradually: inference
 * runs in the embed worker thread (event loop stays free) in small duty-cycled
 * slices, so a cold brain warms at low average CPU while a warm brain is an
 * all-hit no-op. One process, one model copy. Opt out with LWM_WEBAPP_NO_WARM=1.
 * @returns {Promise<void>}
 */
export async function warmHomeWikiGradually() {
  if (process.env.LWM_WEBAPP_NO_WARM === "1") return;
  try {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, WARM_START_DELAY_MS);
      timer.unref?.();
    });
    const { env } = await import("./engine.mjs").then((m) => m.loadEngine());
    const { warmWikiEmbeddings } = await import("../../../scripts/lib/embed-warm.mjs");
    const stats = await warmWikiEmbeddings(env.wikiRoot());
    if (stats.embedded > 0) {
      process.stderr.write(
        `webapp: warmed ${stats.embedded}/${stats.leaves} leaves across ${stats.categories} categories\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`webapp: gradual warm failed (${message})\n`);
  }
}

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
  registerFacetsRoutes(app, appDb);
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

/**
 * Re-check the warm on a timer, not just at boot: a leaf saved after startup used
 * to stay cold until the daemon was restarted, and the first search touching it
 * paid the embedding cost inline. The engine's own due-stamp and lock decide
 * whether a tick does anything, so this timer is only a scheduler — the hourly
 * cron is what makes an install without a running webapp converge.
 *
 * unref'd so it never holds the process open, and in-flight-guarded so a warm
 * that outlives its interval is not started twice.
 * @returns {{ stop: () => void } | null}
 */
export function startWarmTimer() {
  if (process.env.LWM_WEBAPP_NO_WARM === "1") return null;
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { env } = await import("./engine.mjs").then((m) => m.loadEngine());
      const { warmWikiEmbeddingsIfDue } = await import("../../../scripts/lib/embed-warm.mjs");
      await warmWikiEmbeddingsIfDue(env.wikiRoot());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`webapp: scheduled warm failed (${message})\n`);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(tick, WARM_TICK_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export async function start() {
  const app = buildApp();
  await app.listen({ port: PORT, host: HOST });
  void warmHomeWikiGradually();
  startWarmTimer();
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
