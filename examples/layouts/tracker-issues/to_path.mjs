// tracker-issues / to_path.mjs
//
// Forward path generators for the tracker-issues topology. One named export
// per `file_kind` declared in .llmwiki.layout.yaml; the loader resolves
// `to_path_file: ./layout/to_path.mjs` by looking up the export whose name
// matches the file_kind (knowledge, plan, ...). Pure-deterministic — no IO,
// no global state, same input always produces the same output.
//
// Signature:
//   knowledge(facets) -> string
//   plan(facets) -> string
//
// Path shape:
//   knowledge: issues/<TRACKER>/<PREFIX>/<thousands>/<hundreds_tens>/<units>/<PREFIX>-<N>.md
//   plan:      issues/<TRACKER>/<PREFIX>/<thousands>/<hundreds_tens>/<units>/<lifecycle>/<PREFIX>-<N>-<slug>.plan.md

function digitBuckets(n) {
  const number = Number(n);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error(`'number' must be a positive integer; got ${JSON.stringify(n)}`);
  }
  return {
    n: number,
    thousands: Math.floor(number / 1000),
    hundredsTens: Math.floor((number % 1000) / 10),
    units: number % 10,
  };
}

export function knowledge({ tracker, prefix, number }) {
  const b = digitBuckets(number);
  return `issues/${tracker}/${prefix}/${b.thousands}/${b.hundredsTens}/${b.units}/${prefix}-${b.n}.md`;
}

export function plan({ tracker, prefix, number, lifecycle, slug }) {
  const b = digitBuckets(number);
  return `issues/${tracker}/${prefix}/${b.thousands}/${b.hundredsTens}/${b.units}/${lifecycle}/${prefix}-${b.n}-${slug}.plan.md`;
}
