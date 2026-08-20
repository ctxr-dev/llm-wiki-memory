import { test, expect } from "@playwright/test";
import { openCategories, tree } from "./helpers";

type Page = import("@playwright/test").Page;
type Locator = import("@playwright/test").Locator;

const KAFKA_REF = "brain:knowledge/backend/decision/architecture/kafka.md";
const TREE_REF = "brain:knowledge/frontend/decision/architecture/react.md";
const ESCALATION_ID = "issues/JIRA/DEV/134/9/6/DEV-134096.md";
const ESCALATION_REF = `brain:${ESCALATION_ID}`;
const TRANSPARENT = "rgba(0, 0, 0, 0)";

const refChip = (page: Page, ref: string) => page.locator(`.md-body a[data-wiki-ref="${ref}"]`);

const externalLink = (page: Page) => page.locator(".md-body a.external-link");

const defTokenLink = (page: Page) => page.locator('.md-body a[data-def-token="E1"]');

const tabItems = (page: Page) =>
  page.locator('div:has(> [draggable="true"])').locator('[draggable="true"]');

async function openRefsDemo(page: Page) {
  await openCategories(page);
  await tree(page).getByRole("button", { name: "Investigations" }).click();
  await tree(page).getByRole("button", { name: "Reference Demo" }).click();
  await expect(page.getByRole("heading", { name: "Reference Demo", level: 1 })).toBeVisible();
}

async function paintOf(locator: Locator) {
  let paint = { color: "", decoration: "", background: "" };
  await expect(async () => {
    paint = await locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.getPropertyValue("color"),
        decoration: style.getPropertyValue("text-decoration-line"),
        background: style.getPropertyValue("background-color"),
      };
    });
    expect(paint.color).not.toBe("");
    expect(paint.decoration).not.toBe("");
    expect(paint.background).not.toBe("");
  }).toPass();
  return paint;
}

async function expectAnchorKindsStayDistinct(page: Page) {
  const chip = await paintOf(refChip(page, KAFKA_REF));
  const chipCode = await paintOf(refChip(page, KAFKA_REF).locator("code"));
  const external = await paintOf(externalLink(page));
  const defToken = await paintOf(defTokenLink(page));
  expect(chip.color).not.toBe(external.color);
  expect(defToken.color).not.toBe(external.color);
  expect(chip.color).not.toBe(defToken.color);
  expect(chip.decoration).toBe("none");
  expect(external.decoration).toContain("underline");
  expect(chip.background).not.toBe(TRANSPARENT);
  expect(chipCode.background).toBe(TRANSPARENT);
}

test("wiki refs, definition tokens and external links stay distinct in both themes", async ({
  page,
}) => {
  await openRefsDemo(page);
  await expectAnchorKindsStayDistinct(page);
  await page.getByRole("button", { name: "toggle theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectAnchorKindsStayDistinct(page);
});

test("a reference inside a raw <pre> adds no width, so a topology tree stays aligned", async ({
  page,
}) => {
  await openRefsDemo(page);
  const treeChip = refChip(page, TREE_REF);
  await expect(treeChip).toBeVisible();
  const width = await treeChip.evaluate((element) => {
    const contents = document.createRange();
    contents.selectNodeContents(element);
    return {
      anchor: element.getBoundingClientRect().width,
      text: contents.getBoundingClientRect().width,
    };
  });
  expect(Math.abs(width.anchor - width.text)).toBeLessThan(1);
  await expect(treeChip.locator("svg")).toBeHidden();
  await expect(treeChip).toHaveCSS("background-color", TRANSPARENT);
});

test("clicking a reference whose target does not exist reports it instead of failing silently", async ({
  page,
}) => {
  await openRefsDemo(page);
  const openedBefore = await tabItems(page).count();
  await refChip(page, ESCALATION_REF).click();
  await expect(page).toHaveURL(new RegExp(`#brain:${ESCALATION_ID.replace(/[/.]/g, "\\$&")}$`));
  await expect(tabItems(page)).toHaveCount(openedBefore + 1);
  await expect(page.getByText(/404/)).toBeVisible();
  await expect(tabItems(page).filter({ hasText: "DEV-134096" })).toHaveCount(1);
  await tabItems(page)
    .filter({ hasText: "DEV-134096" })
    .getByRole("button", { name: "close tab" })
    .click();
  await expect(page.getByRole("heading", { name: "Reference Demo", level: 1 })).toBeVisible();
});
