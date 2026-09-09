import { svgStyle } from "./style.mjs";

import { validateSvg } from "./validate.mjs";
import { block, draw } from "./index.mjs";

/** @typedef {import("./types.mjs").DiagramSpec} DiagramSpec */

/**
 * Build a standalone HTML page for visual review.
 *
 * It reproduces the READING surface exactly: the same `<style>` block and the
 * same `<div class="dd">` wrapper the wiki app renders, so what is screenshotted
 * is what a reader sees. A preview that renders the SVG some other way is worse
 * than no preview, because it certifies markup nobody will ever look at — which
 * is how the blank-line truncation stayed hidden.
 *
 * Any geometric findings are printed next to each diagram rather than hidden, so
 * the visual pass and the mechanical pass are read together.
 * @param {{ name: string, spec: DiagramSpec }[]} entries
 * @param {{ dark?: boolean }} [opts]
 * @returns {string}
 */
export function previewHtml(entries, opts = {}) {
  const sections = entries
    .map(({ name, spec }) => {
      let body;
      /** @type {import("./validate.mjs").Finding[]} */
      let findings = [];
      try {
        body = block(spec);
        findings = validateSvg(draw(spec));
      } catch (err) {
        body = `<p class="err">THREW: ${err instanceof Error ? err.message : String(err)}</p>`;
      }
      const report = findings.length
        ? `<ul class="findings">${findings
            .map((f) => `<li><b>${f.kind}</b> ${f.detail}</li>`)
            .join("")}</ul>`
        : `<p class="ok">no geometric findings</p>`;
      return `<section><h2>${name} <small>${spec.kind ?? "flow"}</small></h2>${report}${body}</section>`;
    })
    .join("\n");

  return [
    "<!doctype html>",
    `<html class="${opts.dark ? "dark" : ""}"><head><meta charset="utf-8">`,
    "<title>diagram preview</title>",
    svgStyle(),
    "<style>",
    "body{margin:0;padding:24px;background:#f5f5f5;color:#2d3142;",
    "font:14px ui-sans-serif,system-ui,-apple-system,sans-serif}",
    "html.dark body{background:#22252f;color:#f5f5f5}",
    "section{margin:0 0 40px;padding:16px;border:1px solid rgba(45,49,66,.15);border-radius:8px;background:#fff}",
    "html.dark section{background:#2d3142;border-color:rgba(245,245,245,.15)}",
    "h2{margin:0 0 8px;font-size:15px}h2 small{opacity:.5;font-weight:400}",
    ".ok{margin:0 0 12px;color:#3a7d44;font-size:12px}",
    ".err{color:#c0392b;font-weight:600}",
    ".findings{margin:0 0 12px;padding-left:18px;color:#c0392b;font-size:12px}",
    ".dd svg{width:100%;height:auto}",
    "</style></head><body>",
    sections,
    "</body></html>",
  ].join("\n");
}
