import { MONO_CH, NAME_CH, assemble, esc, snap, wrap } from "./text.mjs";
import { edgeClass, markerFor, markers } from "./parts.mjs";

/** @typedef {import("./types.mjs").SequenceSpec} SequenceSpec */

const SEQ = { actorW: 138, actorGap: 40, top: 30, lead: 34, pad: 22 };

/**
 * Render a sequence diagram to inline SVG: actor heads across the top, lifelines
 * down, and one row per step.
 * @param {SequenceSpec} spec
 * @returns {string}
 */
export function renderSequence(spec) {
  const id = spec.id;
  const aw = spec.actorW ?? SEQ.actorW;
  const ag = spec.actorGap ?? SEQ.actorGap;
  /** @type {Map<string, number>} */
  const xs = new Map();
  /** @type {{ actor: import("./types.mjs").SequenceActor, lines: string[], subs: string[], i: number }[]} */
  const heads = [];
  let headH = 34;
  spec.actors.forEach((actor, i) => {
    const lines = wrap(actor.label, Math.floor((aw - 14) / NAME_CH));
    const subs = actor.sub ? wrap(actor.sub, Math.floor((aw - 16) / MONO_CH)) : [];
    headH = Math.max(
      headH,
      snap(14 + lines.length * 14 + (subs.length ? subs.length * 11 + 2 : 0)),
    );
    heads.push({ actor, lines, subs, i });
    xs.set(actor.id, SEQ.pad + i * (aw + ag) + aw / 2);
  });

  let y = SEQ.top + headH + SEQ.lead;
  /** @type {string[]} */
  const body = [];
  /** @type {string[]} */
  const labels = [];
  for (const step of spec.steps) {
    if (step.note) {
      /** @type {number[]} */
      const cols = [];
      for (const key of step.over ?? spec.actors.map((a) => a.id)) {
        const x = xs.get(key);
        if (x !== undefined) cols.push(x);
      }
      if (cols.length === 0) throw new Error(`note spans no known actor: ${step.note}`);
      const x1 = Math.min(...cols) - aw / 2 + 6;
      const x2 = Math.max(...cols) + aw / 2 - 6;
      const lines = wrap(step.note, Math.floor((x2 - x1 - 16) / MONO_CH));
      const h = lines.length * 11 + 12;
      const cx = (x1 + x2) / 2;
      body.push(
        `<rect class="seqnote" x="${x1}" y="${y}" width="${x2 - x1}" height="${h}" rx="4"/>` +
          `<text class="el" x="${cx}" y="${y + 14}" text-anchor="middle">` +
          lines
            .map((l, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : 11}">${esc(l)}</tspan>`)
            .join("") +
          "</text>",
      );
      y += h + 14;
      continue;
    }
    if (step.phase) {
      const right = SEQ.pad + spec.actors.length * (aw + ag) - ag;
      body.push(
        `<line class="seqdiv" x1="${SEQ.pad}" y1="${y + 6}" x2="${right}" y2="${y + 6}"/>` +
          `<rect class="zmask" x="${SEQ.pad + 10}" y="${y}" width="${step.phase.length * 5.6 + 12}" height="12" rx="2"/>` +
          `<text class="zlab" x="${SEQ.pad + 16}" y="${y + 9}">${esc(step.phase.toUpperCase())}</text>`,
      );
      y += 26;
      continue;
    }
    const kind = step.kind ?? "sync";
    const cls = edgeClass(kind);
    const lcls = kind === "focal" ? "el focal" : "el";
    const marker = markerFor(id, kind);
    const x1 = step.from === undefined ? undefined : xs.get(step.from);
    const x2 = step.to === undefined ? undefined : xs.get(step.to);
    if (x1 === undefined || x2 === undefined) {
      throw new Error(`unknown actor in ${step.from}->${step.to}`);
    }
    if (step.from === step.to) {
      const lines = wrap(step.label ?? "", 34);
      const h = lines.length * 11;
      body.push(
        `<path class="${cls}" d="M${x1},${y} H${x1 + 26} Q${x1 + 34},${y} ${x1 + 34},${y + 9} V${y + 17} Q${x1 + 34},${y + 26} ${x1 + 26},${y + 26} H${x1 + 4}" marker-end="url(#${marker})"/>`,
      );
      labels.push(
        `<text class="${lcls}" x="${x1 + 44}" y="${y + 8}">` +
          lines
            .map((l, i) => `<tspan x="${x1 + 44}" dy="${i === 0 ? 0 : 11}">${esc(l)}</tspan>`)
            .join("") +
          "</text>",
      );
      y += Math.max(34, h + 16);
      continue;
    }
    const dir = Math.sign(x2 - x1);
    const lines = wrap(
      step.label ?? "",
      Math.max(18, Math.floor((Math.abs(x2 - x1) - 20) / MONO_CH)),
    );
    const cx = (x1 + x2) / 2;
    // The label sits ABOVE its arrow, so the arrow's y depends on how many lines
    // the label wrapped to; computing it after wrapping is what keeps a two-line
    // label from overlapping the run above it.
    const arrowY = y + lines.length * 11 + 8;
    labels.push(
      `<text class="${lcls}" x="${cx}" y="${y + 9}" text-anchor="middle">` +
        lines
          .map((l, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : 11}">${esc(l)}</tspan>`)
          .join("") +
        "</text>",
    );
    body.push(
      `<path class="${cls}" d="M${x1 + dir * 4},${arrowY} H${x2 - dir * 5}" marker-end="url(#${marker})"/>`,
    );
    y = arrowY + 16;
  }

  const bottom = y + 6;
  const lifelines = spec.actors
    .map(
      (a) =>
        `<line class="life" x1="${xs.get(a.id)}" y1="${SEQ.top + headH}" x2="${xs.get(a.id)}" y2="${bottom}"/>`,
    )
    .join("");
  const headBoxes = heads
    .map((h) => {
      const x = SEQ.pad + h.i * (aw + ag);
      const cx = x + aw / 2;
      const top = SEQ.top + (headH - (h.lines.length * 14 + h.subs.length * 11)) / 2 + 10;
      return (
        `<rect class="nb ${h.actor.kind ?? "backend"}" x="${x}" y="${SEQ.top}" width="${aw}" height="${headH}" rx="6"/>` +
        `<text class="nn" x="${cx}" y="${top}" text-anchor="middle">` +
        h.lines
          .map((l, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : 14}">${esc(l)}</tspan>`)
          .join("") +
        "</text>" +
        (h.subs.length
          ? `<text class="ns" x="${cx}" y="${top + (h.lines.length - 1) * 14 + 12}" text-anchor="middle">` +
            h.subs
              .map((l, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : 11}">${esc(l)}</tspan>`)
              .join("") +
            "</text>"
          : "")
      );
    })
    .join("");

  const w = SEQ.pad * 2 + spec.actors.length * aw + (spec.actors.length - 1) * ag;
  return assemble([
    `<svg viewBox="0 0 ${snap(w)} ${snap(bottom + SEQ.pad)}" role="img" aria-label="${esc(spec.title)}">`,
    markers(id),
    `<rect class="bg" x="0" y="0" width="${snap(w)}" height="${snap(bottom + SEQ.pad)}" rx="10"/>`,
    lifelines,
    body.join(""),
    headBoxes,
    labels.join(""),
    "</svg>",
  ]);
}
