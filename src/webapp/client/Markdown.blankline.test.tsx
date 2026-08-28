import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";

/**
 * These tests pin a DEPENDENCY's behaviour, not our own code, and that is the
 * point. CommonMark terminates an HTML block at a blank line, so a diagram
 * containing one is silently truncated when the leaf renders: the generator's
 * `assemble()` guard exists solely to prevent that, and nothing here proved the
 * hazard was real. A guard defending an unpinned assumption quietly becomes
 * decoration the day the assumption changes.
 *
 * The negative test is the valuable one. If a remark/micromark upgrade ever stops
 * splitting on the blank line, it fails and tells us the generator guard can be
 * relaxed, rather than leaving a permanent no-op nobody notices.
 */

const WHOLE = [
  "# Diagram",
  "",
  '<div class="dd">',
  '<svg viewBox="0 0 200 100" role="img" aria-label="flow">',
  '<rect x="1" y="1" width="198" height="98"/>',
  '<text x="100" y="55">usher</text>',
  '<text x="100" y="80">tail-marker</text>',
  "</svg>",
  "</div>",
  "",
  "Trailing prose.",
].join("\n");

/**
 * Byte-identical to WHOLE except for one blank line in the middle of the svg.
 */
const SPLIT = [
  "# Diagram",
  "",
  '<div class="dd">',
  '<svg viewBox="0 0 200 100" role="img" aria-label="flow">',
  '<rect x="1" y="1" width="198" height="98"/>',
  '<text x="100" y="55">usher</text>',
  "",
  '<text x="100" y="80">tail-marker</text>',
  "</svg>",
  "</div>",
  "",
  "Trailing prose.",
].join("\n");

test("a blank-line-free inline svg renders whole, tail included", () => {
  const { container } = render(<Markdown body={WHOLE} />);
  const svg = container.querySelector("svg");
  expect(svg).toBeTruthy();
  expect(svg?.getAttribute("viewBox")).toBe("0 0 200 100");
  expect(container.querySelectorAll("text").length).toBe(2);
  expect(container.textContent).toContain("tail-marker");
  expect(container.textContent).toContain("Trailing prose.");
});

test("a blank line INSIDE the svg truncates it, which is why the generator refuses one", () => {
  const { container } = render(<Markdown body={SPLIT} />);
  const svg = container.querySelector("svg");
  /**
   * The <svg> element does not survive as a single intact node carrying both of
   * its text children: the blank line closed the HTML block, so everything after
   * it is no longer part of the same element.
   */
  const textsInsideSvg = svg ? svg.querySelectorAll("text").length : 0;
  expect(textsInsideSvg).toBeLessThan(2);
});

test("the truncation is caused by the BLANK line alone, not by the markup", () => {
  /**
   * Same markup, same nesting, one blank line apart: the only variable is the
   * blank line, so the two renders differing proves what the guard defends.
   */
  const whole = render(<Markdown body={WHOLE} />);
  const split = render(<Markdown body={SPLIT} />);
  const wholeTexts = whole.container.querySelector("svg")?.querySelectorAll("text").length ?? 0;
  const splitTexts = split.container.querySelector("svg")?.querySelectorAll("text").length ?? 0;
  expect(wholeTexts).toBe(2);
  expect(splitTexts).toBeLessThan(wholeTexts);
});
