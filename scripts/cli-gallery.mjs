import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { out } from "./cli-io.mjs";
import { draw } from "./lib/diagrams/index.mjs";
import { svgStyle } from "./lib/diagrams/style.mjs";
import { galleryHtml, galleryMarkdown } from "./lib/gallery/page.mjs";
import { allExamples } from "./lib/gallery/index.mjs";

/** @typedef {import("./lib/gallery/page.mjs").Example} Example */

const repoRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const DOCS = path.join(repoRoot, "docs");
const MD_PATH = path.join(DOCS, "diagrams-examples.md");
const HTML_PATH = path.join(DOCS, "diagrams-examples.html");
const IMG_DIR = path.join(DOCS, "img", "diagrams");

/**
 * Rasterise each example to PNG through Playwright's Chromium.
 *
 * Optional ON PURPOSE. The markdown and the HTML must regenerate on any machine,
 * including CI without a browser, so a missing Chromium reports what it would
 * have written and leaves the committed images untouched rather than failing the
 * docs build or, worse, deleting them.
 * @param {Example[]} examples
 * @returns {Promise<{ wrote: string[], skipped?: string }>}
 */
async function rasterise(examples) {
  /** @type {any} */
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    try {
      ({ chromium } = await import("@playwright/test"));
    } catch {
      return { wrote: [], skipped: "playwright is not installed; run it from src/webapp" };
    }
  }
  /** @type {any} */
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    return {
      wrote: [],
      skipped: `chromium failed to launch: ${err instanceof Error ? err.message : err}`,
    };
  }

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const css = svgStyle();
  /** @type {string[]} */
  const wrote = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    for (const example of examples) {
      const svg = draw(example.spec);
      const view = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg);
      const w = view ? Math.ceil(Number(view[3])) : 1000;
      const h = view ? Math.ceil(Number(view[4])) : 500;
      await page.setViewportSize({ width: w, height: h });
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8">${css}` +
          `<style>html,body{margin:0;padding:0;background:transparent}` +
          `.dd svg{display:block;width:${w}px;height:${h}px}</style></head>` +
          `<body><div class="dd">${svg}</div></body></html>`,
        { waitUntil: "load" },
      );
      const file = path.join(IMG_DIR, `${example.name}.png`);
      const element = await page.$(".dd");
      await element.screenshot({ path: file, omitBackground: false });
      wrote.push(path.relative(repoRoot, file));
    }
  } finally {
    await browser.close();
  }
  return { wrote };
}

/**
 * `gallery [--png]` — regenerate `docs/diagrams-examples.md` and its HTML twin.
 *
 * Both files are GENERATED and carry a note saying so; the specs behind them live
 * in `scripts/lib/gallery/`. Keeping the generator here rather than in a one-off
 * script means the docs are rebuilt the same way by anyone, and `test/gallery-*`
 * already guarantees every example renders cleanly before it reaches the page.
 * @param {string[]} rest
 * @returns {Promise<void>}
 */
export async function handleGallery(rest) {
  const examples = allExamples();
  fs.mkdirSync(DOCS, { recursive: true });

  fs.writeFileSync(HTML_PATH, galleryHtml(examples));
  fs.writeFileSync(
    MD_PATH,
    galleryMarkdown(examples, {
      imageDir: "img/diagrams",
      htmlPath: "diagrams-examples.html",
    }),
  );

  const png = rest.includes("--png")
    ? await rasterise(examples)
    : { wrote: [], skipped: "--png not requested" };

  out({
    ok: true,
    examples: examples.length,
    kinds: [...new Set(examples.map((e) => e.kind))].length,
    markdown: path.relative(repoRoot, MD_PATH),
    html: path.relative(repoRoot, HTML_PATH),
    images: png.wrote.length,
    imagesSkipped: png.skipped,
  });
}
