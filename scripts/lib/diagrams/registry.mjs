// The type registry: one entry per diagram kind, keyed by `spec.kind`.
//
// Dispatch lives here rather than in a growing `if` chain in `index.mjs` so a new
// type is added by registering it, and so `validate`, the preview harness and the
// DOCS can enumerate what exists without a hand-maintained second list. A
// renderer is a pure `(spec) => string` returning the inline `<svg>` element.
//
// Each entry carries a one-line `use` and a `pick` cue, and that is deliberate:
// an agent choosing a diagram type needs to know WHEN to reach for each one, and
// the only version of that list which cannot rot is the one generated from the
// same registry the dispatcher uses. Documenting the catalogue by hand guarantees
// it drifts the first time a type is added; `test/diagram-docs.test.mjs` fails if
// the rendered rule text and this registry ever disagree.
//
// Keep `use` and `pick` to ONE short line each. They are read by an agent that is
// choosing, not studying: the whole catalogue has to stay cheap enough to load in
// full, or it will be skipped and the choice made badly.

/**
 * @typedef {Object} KindInfo
 * @property {(spec: any) => string} render
 * @property {string} use what the type is for
 * @property {string} pick the cue that should make you choose it over its neighbours
 */

/** @type {Map<string, KindInfo>} */
const renderers = new Map();

/**
 * @param {string} kind
 * @param {(spec: any) => string} render
 * @param {{ use: string, pick: string }} doc
 * @returns {void}
 */
export function registerRenderer(kind, render, doc) {
  if (renderers.has(kind)) throw new Error(`diagram kind registered twice: ${kind}`);
  if (!doc || !doc.use || !doc.pick) {
    throw new Error(`diagram kind ${kind} must register a use and a pick cue for the catalogue`);
  }
  renderers.set(kind, { render, use: doc.use, pick: doc.pick });
}

/**
 * @param {string} kind
 * @returns {(spec: any) => string}
 */
export function rendererFor(kind) {
  const found = renderers.get(kind);
  if (!found) {
    throw new Error(`unknown diagram kind "${kind}"; known kinds: ${knownKinds().join(", ")}`);
  }
  return found.render;
}

/** @returns {string[]} */
export function knownKinds() {
  return [...renderers.keys()].sort();
}

/**
 * The catalogue, for the CLI and for the generated rule table.
 * @returns {{ kind: string, use: string, pick: string }[]}
 */
export function kindCatalogue() {
  return knownKinds().map((kind) => {
    const info = /** @type {KindInfo} */ (renderers.get(kind));
    return { kind, use: info.use, pick: info.pick };
  });
}

/**
 * The catalogue as the markdown table the diagram rule embeds.
 *
 * Generated, never authored: `--list` prints it and the docs test compares the
 * rule's committed copy against it, so the two cannot drift.
 * @returns {string}
 */
export function catalogueTable() {
  const rows = kindCatalogue().map((c) => `| \`${c.kind}\` | ${c.use} | ${c.pick} |`);
  return ["| kind | use it for | pick it when |", "|---|---|---|", ...rows].join("\n");
}
