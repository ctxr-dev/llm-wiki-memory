import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ATOM_TYPES,
  TASK_TYPES,
  PRIORITY_ORDER,
  PRIORITY_META,
  humanizeFacet,
  humanizeValue,
} from "./facets";

function frozenList(name: string): string[] {
  const source = readFileSync(resolve(process.cwd(), "../../scripts/lib/datasets.mjs"), "utf8");
  const start = source.indexOf(`${name} = Object.freeze([`);
  if (start === -1) throw new Error(`${name} not found in datasets.mjs`);
  const end = source.indexOf("])", start);
  const block = source.slice(start, end);
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("atom, task, and priority lists match the engine source (no drift)", () => {
  expect(ATOM_TYPES).toEqual(frozenList("ATOM_TYPES_LIST"));
  expect(TASK_TYPES).toEqual(frozenList("TASK_TYPES_LIST"));
  expect(PRIORITY_ORDER).toEqual(frozenList("PRIORITY_VALUES"));
});

test("every priority value has meta", () => {
  for (const value of PRIORITY_ORDER) {
    expect(PRIORITY_META[value].label).toBe(value);
    expect(PRIORITY_META[value].explanation.length).toBeGreaterThan(0);
    expect(PRIORITY_META[value].classes.length).toBeGreaterThan(0);
  }
});

test("humanizeFacet turns slugs into readable labels", () => {
  expect(humanizeFacet("atom_type")).toBe("Atom type");
  expect(humanizeFacet("priority")).toBe("Priority");
  expect(humanizeFacet("error_pattern")).toBe("Error pattern");
  expect(humanizeFacet("custom_field")).toBe("Custom field");
});

test("humanizeValue title-cases dash, underscore, and camelCase values", () => {
  expect(humanizeValue("bug-root-cause")).toBe("Bug Root Cause");
  expect(humanizeValue("camelCase")).toBe("Camel Case");
  expect(humanizeValue("under_score")).toBe("Under Score");
  expect(humanizeValue("backend")).toBe("Backend");
  expect(humanizeValue("self-improvement-lesson")).toBe("Self Improvement Lesson");
});
