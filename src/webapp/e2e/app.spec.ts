import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  tree,
  palette,
  openCategories,
  drillToArchitecture,
  openKafka,
  openReact,
} from "./helpers";

test("renders a document with markdown, a table, and a code block", async ({ page }) => {
  await openKafka(page);
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("cell", { name: "RabbitMQ" })).toBeVisible();
  await expect(page.getByText('const topic = "events";')).toBeVisible();
});

test("nav leaf shows its title and a rich hover popup with details", async ({ page }) => {
  await openCategories(page);
  await drillToArchitecture(page, /^Backend/);
  const doc = tree(page).getByRole("button", { name: "Kafka choice" });
  await expect(doc).toBeVisible();
  await doc.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Knowledge › Backend › Decision");
  await expect(tip).toContainText("Type");
  await expect(tip).toContainText("kafka.md");
});

test("category counts exclude archived leaves", async ({ page }) => {
  await openCategories(page);
  await expect(tree(page).getByRole("button", { name: /^Knowledge/ })).toContainText("3");
});

test("the Show archived toggle includes archived leaves in the category counts", async ({
  page,
}) => {
  await openCategories(page);
  const browse = tree(page);
  await expect(browse.getByRole("button", { name: /^Knowledge/ })).toContainText("3");
  await browse.getByRole("button", { name: "Category settings" }).click();
  await page.getByRole("switch", { name: "Show archived" }).click();
  await page.keyboard.press("Escape");
  await expect(browse.getByRole("button", { name: /^Knowledge/ })).toContainText("4");
});

test("open tabs show the document title, not the filename", async ({ page }) => {
  await openKafka(page);
  const tab = page.locator('[draggable="true"]').filter({ hasText: "Kafka choice" });
  await expect(tab).toBeVisible();
  await expect(tab).not.toContainText("kafka.md");
});

test("a lone sentinel level is collapsed, so no 'Unspecified' step appears", async ({ page }) => {
  await openCategories(page);
  await tree(page).getByRole("button", { name: "Investigations" }).click();
  await expect(tree(page).getByRole("button", { name: "Probe Note" })).toBeVisible();
  await expect(tree(page).getByRole("button", { name: "Unspecified" })).toHaveCount(0);
});

test("drilling deep into a facet collapses a lone sentinel subject to reach the leaf", async ({
  page,
}) => {
  await openCategories(page);
  const browse = tree(page);
  await browse.getByRole("button", { name: /^Self Improvement/ }).click();
  await browse.getByRole("button", { name: /^Workflow/ }).click();
  await browse.getByRole("button", { name: /^Planning/ }).click();
  await expect(
    browse.getByRole("button", { name: "Preserve plan detail on rewrite" }),
  ).toBeVisible();
  await expect(browse.getByRole("button", { name: "Unspecified" })).toHaveCount(0);
});

test("a large nav doc list is windowed (virtualized)", async ({ page }) => {
  await openCategories(page);
  const browse = tree(page);
  await browse.getByRole("button", { name: /^Self Improvement/ }).click();
  await browse.getByRole("button", { name: /^Bulk/ }).click();
  await browse.getByRole("button", { name: /^Implementation/ }).click();
  await expect(browse.getByRole("button", { name: "Bulk Doc 00" })).toBeVisible();
  const rendered = await browse.getByRole("button", { name: /^Bulk Doc / }).count();
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(55);
});

test("a breadcrumb segment drives the nav tree", async ({ page }) => {
  await openKafka(page);
  const crumbs = page.getByRole("navigation", { name: "breadcrumb" });
  await expect(crumbs.getByRole("button", { name: "Architecture" })).toBeVisible();
  await crumbs.getByRole("button", { name: "Backend" }).click();
  await expect(tree(page).getByRole("button", { name: /^Decision/ })).toBeVisible();
});

test("the TOC/Related column is sticky", async ({ page }) => {
  await openKafka(page);
  await expect(page.locator("aside")).toHaveCSS("position", "sticky");
});

test("the Related panel lists a titled sibling document with a hover popup", async ({ page }) => {
  await openKafka(page);
  const aside = page.locator("aside");
  await expect(aside.getByText("Related")).toBeVisible();
  const item = aside.getByRole("button", { name: "React And Vite" });
  await expect(item).toBeVisible({ timeout: 15000 });
  await item.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("react.md");
});

test("the Add wiki dialog offers a path input, clipboard paste, and a native folder picker", async ({
  page,
}) => {
  await openCategories(page);
  const wikisNav = page.getByRole("navigation", { name: "wikis" });
  await wikisNav.getByRole("button", { name: "Add wiki" }).click();
  const dialog = page.getByRole("dialog", { name: "add wiki" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder(/absolute\/path/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "paste from clipboard" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Choose folder/ })).toBeVisible();
  await dialog.getByRole("button", { name: "close" }).click();
  await expect(dialog).toBeHidden();
});

test("adding a non-wiki folder surfaces a friendly error", async ({ page }) => {
  await openCategories(page);
  const wikisNav = page.getByRole("navigation", { name: "wikis" });
  await wikisNav.getByRole("button", { name: "Add wiki" }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/nonexistent-wiki-xyz");
  await wikisNav.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/No .llm-wiki-memory found/)).toBeVisible();
});

test("re-clicking the current wiki resets the nav to Categories", async ({ page }) => {
  await openCategories(page);
  await tree(page)
    .getByRole("button", { name: /^Knowledge/ })
    .click();
  await tree(page)
    .getByRole("button", { name: /^Backend/ })
    .click();
  await expect(page.getByText("Categories")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "wikis" })
    .getByRole("button")
    .filter({ hasText: "home" })
    .click();
  await expect(page.getByText("Categories")).toBeVisible();
});

test("the body metadata block is split out and collapsible", async ({ page }) => {
  await openReact(page);
  await expect(page.getByRole("heading", { name: "React And Vite", level: 1 })).toBeVisible();
  await expect(page.getByText(/We use .*React.* with Vite/)).toBeVisible();
  const toggle = page.getByRole("button", { name: /metadata · 3 fields/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("a facet chip opens a focused search with a titled, located result", async ({ page }) => {
  await openKafka(page);
  await page.getByRole("button", { name: /area: Backend/ }).click();
  await expect(page.getByRole("button", { name: "remove Area: backend" })).toBeVisible();
  await expect(page.getByText(/Knowledge › Backend › Decision/).first()).toBeVisible({
    timeout: 15000,
  });
});

test("command palette (⌘K) searches and opens a titled result", async ({ page }) => {
  await openCategories(page);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder(/Search or jump/);
  await expect(input).toBeVisible();
  await input.fill("kafka");
  const result = palette(page).getByRole("button").filter({ hasText: "Kafka choice" });
  await expect(result.first()).toBeVisible({ timeout: 15000 });
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
});

test("search results highlight the matched query term", async ({ page }) => {
  await openCategories(page);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder(/Search or jump/);
  await input.fill("kafka");
  await expect(
    palette(page).getByRole("button").filter({ hasText: "Kafka choice" }).first(),
  ).toBeVisible({ timeout: 15000 });
  await expect(palette(page).locator("mark").filter({ hasText: /kafka/i }).first()).toBeVisible();
});

test("a search snippet shows prose, not the frontmatter-echo preamble", async ({ page }) => {
  await openCategories(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder(/Search or jump/).fill("different requestId order");
  const row = palette(page)
    .getByRole("button")
    .filter({ hasText: "RequestId divergence audit note" });
  await expect(row.first()).toBeVisible({ timeout: 15000 });
  await expect(row.first()).toContainText("The audit topic");
  await expect(row.first()).not.toContainText("status:");
});

test("the empty palette hides the active wiki and hints to search", async ({ page }) => {
  await openCategories(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page).getByText(/Type to search/)).toBeVisible();
  await expect(palette(page).getByText(/Switch to/)).toHaveCount(0);
});

test("the search palette closes with the close button", async ({ page }) => {
  await openCategories(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByPlaceholder(/Search or jump/)).toBeVisible();
  await page.getByRole("button", { name: "close", exact: true }).click();
  await expect(page.getByPlaceholder(/Search or jump/)).toHaveCount(0);
});

test("the Lexical editor opens for a document", async ({ page }) => {
  await openKafka(page);
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText(/Editing/)).toBeVisible();
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
});

test("archiving a document asks for confirmation (cancel leaves it untouched)", async ({
  page,
}) => {
  await openKafka(page);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Archive" }).click();
  const dialog = page.getByRole("dialog", { name: "archive document" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Archive this document/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Editing/)).toBeVisible();
});

test("the Plans board shows plan cards in lifecycle columns", async ({ page }) => {
  await openCategories(page);
  await page.getByRole("button", { name: "plans", exact: true }).click();
  await expect(page.getByText("Rollout plan")).toBeVisible();
  await expect(page.getByText("In progress")).toBeVisible();
});

test("no critical accessibility violations on the document view", async ({ page }) => {
  await openKafka(page);
  const results = await new AxeBuilder({ page }).analyze();
  const critical = results.violations.filter((violation) => violation.impact === "critical");
  expect(critical).toEqual([]);
});
