import { svgStyle } from "../diagrams/style.mjs";
import { block } from "../diagrams/index.mjs";

/** @typedef {{ kind: string, name: string, caption: string, spec: any }} Example */

// The two rendered surfaces of the gallery.
//
// The HTML is the LIVE one: real inline SVG, a light/dark toggle (the theme is
// carried entirely by CSS custom properties, so one payload serves both), and a
// per-diagram full-screen view. The markdown is the PORTABLE one: it embeds PNGs
// because GitHub's sanitizer drops inline `<svg>` outright, so a markdown gallery
// built from SVG would render as nothing precisely where most people read it.

/**
 * @param {Example[]} examples
 * @returns {string}
 */
export function galleryHtml(examples) {
  const cards = examples
    .map(
      (e, i) => `<section class="card" id="${e.name}">
<header>
<div><h2>${escapeHtml(e.kind)}</h2><p>${escapeHtml(e.caption)}</p></div>
<div class="tools">
<a class="btn" href="#${e.name}" title="permalink">#</a>
<button class="btn" data-full="${i}" type="button">Full screen</button>
</div>
</header>
<div class="stage">${block(e.spec)}</div>
</section>`,
    )
    .join("\n");

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>llm-wiki-memory diagram gallery</title>",
    svgStyle(),
    `<style>${PAGE_CSS}</style>`,
    "</head><body>",
    `<header class="top">
<div><h1>Diagram gallery</h1><p>${examples.length} diagram types, every one rendered by the engine in this repo.</p></div>
<button class="btn" id="theme" type="button">Dark</button>
</header>`,
    `<nav class="toc">${examples.map((e) => `<a href="#${e.name}">${escapeHtml(e.kind)}</a>`).join("")}</nav>`,
    cards,
    `<script>${PAGE_JS}</script>`,
    "</body></html>",
  ].join("\n");
}

/**
 * @param {Example[]} examples
 * @param {{ imageDir: string, htmlPath: string }} paths relative to the docs file
 * @returns {string}
 */
export function galleryMarkdown(examples, paths) {
  const rows = examples.map((e) => `| [\`${e.kind}\`](#${e.name}) | ${e.caption} |`).join("\n");

  const sections = examples
    .map(
      (e) => `### ${e.kind}

<a name="${e.name}"></a>

${e.caption}

[![${e.kind} example](${paths.imageDir}/${e.name}.png)](${paths.htmlPath}#${e.name})

[Open full screen](${paths.htmlPath}#${e.name})`,
    )
    .join("\n\n---\n\n");

  return `# Diagram examples

Every diagram type this engine can render, drawn by the engine itself. The subject matter is
one system throughout (an agent memory engine) so the page reads as a tour rather than a set of
unrelated samples.

**[Open the live gallery](${paths.htmlPath})** for full-screen viewing and a dark-mode toggle.
The images below are PNGs on purpose: GitHub's sanitizer strips inline \`<svg>\`, so a markdown
gallery built from SVG renders as nothing in the place most people read it.

## Pick a type

| kind | use it for |
|---|---|
${rows}

The same catalogue is available to an agent at any time with:

\`\`\`
node scripts/cli.mjs render-diagram --list
\`\`\`

## Authoring a diagram

Write a spec, render it, and let the engine refuse anything illegible:

\`\`\`
node scripts/cli.mjs render-diagram --spec my-spec.mjs --strict
node scripts/cli.mjs render-diagram --spec my-spec.mjs --html --out preview.html
\`\`\`

\`--strict\` exits non-zero when the geometric check finds a defect (a label sitting on a box, a
run cutting through an unrelated node, content clipped outside the frame). \`--html\` writes a
page to LOOK at, because the mechanical check and the eye catch different failures.

## Regenerating this page

Both this file and the HTML gallery are GENERATED. Do not hand-edit either: the next
regeneration overwrites them.

\`\`\`
npm run docs:gallery          # rewrites the .md and the .html
npm run docs:gallery -- --png # also re-rasterises every PNG (needs Playwright Chromium)
\`\`\`

To change what the gallery shows, edit the example specs, which live beside the renderers:

- \`scripts/lib/gallery/graph.mjs\` — flow, sequence, flowchart, state, swimlane, tree, org-chart, nested, architecture, er
- \`scripts/lib/gallery/charts.mjs\` — bar, line, scatter, gantt, radar, polar, pyramid, treemap, venn, sankey
- \`scripts/lib/gallery/positional.mjs\` — quadrant, wardley, timeline, loop, fishbone, layers, kanban, medallion, high-level

Each entry is \`{ kind, name, caption, spec }\`. \`name\` is the slug used for the PNG filename and
the anchor, so renaming one changes its permalink. Page layout and styling live in
\`scripts/lib/gallery/page.mjs\`; the generator itself is \`scripts/cli-gallery.mjs\`.

\`test/gallery-*.test.mjs\` asserts every example renders with ZERO geometric findings, so a spec
that would look broken fails the build rather than reaching this page. Adding a new diagram kind
without adding an example here fails \`test/gallery-coverage.test.mjs\`.

The PNG step needs a Chromium that Playwright has already downloaded (the webapp workspace
installs one). Without it, \`--png\` reports what it would have written and leaves the existing
images in place, so the docs still regenerate on a machine with no browser.

${sections}
`;
}

/** @param {string} s @returns {string} */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAGE_CSS = `
:root{color-scheme:light}
html.dark{color-scheme:dark}
body{margin:0;padding:0 24px 64px;background:#f5f5f5;color:#2d3142;
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
html.dark body{background:#22252f;color:#f5f5f5}
.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;
padding:32px 0 16px;position:sticky;top:0;background:inherit;z-index:5}
h1{margin:0;font-size:22px}
.top p{margin:4px 0 0;opacity:.65;font-size:13px}
.btn{appearance:none;border:1px solid rgba(45,49,66,.2);background:#fff;color:inherit;
border-radius:6px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;text-decoration:none}
html.dark .btn{background:#2d3142;border-color:rgba(245,245,245,.2)}
.toc{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 24px}
.toc a{font:500 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;
text-decoration:none;color:inherit;opacity:.7;border:1px solid rgba(45,49,66,.15);
border-radius:999px;padding:3px 10px}
html.dark .toc a{border-color:rgba(245,245,245,.15)}
.toc a:hover{opacity:1;border-color:#eb6c36}
.card{margin:0 0 28px;border:1px solid rgba(45,49,66,.14);border-radius:10px;background:#fff;
overflow:hidden;scroll-margin-top:96px}
html.dark .card{background:#2d3142;border-color:rgba(245,245,245,.14)}
.card header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
padding:14px 16px;border-bottom:1px solid rgba(45,49,66,.1)}
html.dark .card header{border-color:rgba(245,245,245,.1)}
.card h2{margin:0;font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em}
.card header p{margin:4px 0 0;font-size:13px;opacity:.7;max-width:70ch}
.tools{display:flex;gap:6px;flex:none}
.stage{padding:16px}
.stage .dd svg{width:100%;height:auto;display:block}
.card:fullscreen,.card.maxed{background:#f5f5f5;overflow:auto}
html.dark .card:fullscreen,html.dark .card.maxed{background:#22252f}
.card:fullscreen .stage,.card.maxed .stage{display:flex;align-items:center;
justify-content:center;height:calc(100vh - 64px);padding:24px}
.card:fullscreen .stage .dd,.card.maxed .stage .dd{width:100%}
.card:fullscreen .stage .dd svg,.card.maxed .stage .dd svg{max-height:calc(100vh - 112px)}
.card.maxed{position:fixed;inset:0;z-index:20;margin:0;border-radius:0}
`;

// No framework and no build step: the gallery must stay a single file anyone can
// open from disk. Full screen falls back to a fixed-position `maxed` class when
// the Fullscreen API is unavailable or refused (Safari on iOS refuses it for
// non-video elements), and `.card.maxed` above mirrors the `:fullscreen` rules so
// the fallback actually LOOKS like full screen instead of silently doing nothing.
const PAGE_JS = `
document.getElementById("theme").addEventListener("click", (e) => {
  const dark = document.documentElement.classList.toggle("dark");
  e.target.textContent = dark ? "Light" : "Dark";
});
for (const btn of document.querySelectorAll("[data-full]")) {
  btn.addEventListener("click", () => {
    const card = btn.closest(".card");
    if (card.classList.contains("maxed")) { card.classList.remove("maxed"); return; }
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (card.requestFullscreen) card.requestFullscreen().catch(() => card.classList.add("maxed"));
    else card.classList.add("maxed");
  });
}
`;
