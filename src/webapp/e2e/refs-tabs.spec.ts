import { test, expect } from "@playwright/test";
import { palette, openCategories, openKafka, tree } from "./helpers";

type Page = import("@playwright/test").Page;

const KAFKA_ID = "knowledge/backend/decision/architecture/kafka.md";
const KAFKA_REF = `brain:${KAFKA_ID}`;
const REFS_DEMO_ID = "investigations/general/refs-demo.md";
const ESCALATION_REF = "brain:issues/JIRA/DEV/134/9/6/DEV-134096.md";

const tabStrip = (page: Page) => page.locator('div:has(> [draggable="true"])');

const tabItems = (page: Page) => tabStrip(page).locator('[draggable="true"]');

const refChip = (page: Page, ref: string) => page.locator(`.md-body a[data-wiki-ref="${ref}"]`);

const externalLink = (page: Page) => page.locator(".md-body a.external-link");

const refHash = (docId: string) => new RegExp(`#brain:${docId.replace(/\//g, "\\/")}$`);

async function openKafkaAndReact(page: Page) {
  await openKafka(page);
  await page.locator("aside").getByRole("button", { name: "React And Vite" }).click();
}

async function openRefsDemo(page: Page) {
  await openCategories(page);
  await tree(page).getByRole("button", { name: "Investigations" }).click();
  await tree(page).getByRole("button", { name: "Reference Demo" }).click();
  await expect(page.getByRole("heading", { name: "Reference Demo", level: 1 })).toBeVisible();
}

async function closeTabNamed(page: Page, label: string) {
  const tab = tabItems(page).filter({ hasText: label });
  if ((await tab.count()) === 0) return;
  await tab.getByRole("button", { name: "close tab" }).click();
  await expect(tab).toHaveCount(0);
}

test("the copy-reference button copies the canonical reference and shows a copied state", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openKafka(page);
  await page.getByRole("button", { name: "copy reference" }).click();
  await expect(page.getByRole("button", { name: "reference copied" })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(KAFKA_REF);
});

test("pasting a reference into search jumps straight to the document", async ({ page }) => {
  await openCategories(page);
  await page.keyboard.press("Meta+k");
  await palette(page)
    .getByPlaceholder(/Search or jump/)
    .fill(KAFKA_REF);
  // Target the reference ROW, not the id text: any result whose snippet quotes
  // that id also matches it, and the seeded Reference Demo leaf exists precisely
  // to contain references. Only a ref-kind row carries an exact "Reference" badge.
  const referenceRow = palette(page)
    .getByRole("button")
    .filter({ has: page.getByText("Reference", { exact: true }) });
  await expect(referenceRow).toBeVisible();
  await referenceRow.click();
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
});

test("opening a document reflects its reference in the URL hash", async ({ page }) => {
  await openKafka(page);
  await expect(page).toHaveURL(new RegExp(`#brain:${KAFKA_ID.replace(/\//g, "\\/")}$`));
});

test("loading a URL that carries a reference hash opens that document", async ({ page }) => {
  await openCategories(page);
  await page.goto(`/#${KAFKA_REF}`);
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
  await expect(
    page.locator('[draggable="true"]').filter({ hasText: "Kafka choice" }),
  ).toBeVisible();
});

test("tabs can be dragged into a new order", async ({ page }) => {
  await openKafkaAndReact(page);
  const strip = tabStrip(page);
  await expect(strip.locator('[draggable="true"]').first()).toContainText("Kafka choice");
  await strip
    .getByRole("button", { name: "React And Vite" })
    .dragTo(strip.getByRole("button", { name: "Kafka choice" }));
  await expect(strip.locator('[draggable="true"]').first()).toContainText("React And Vite");
});

test("the tab context menu can Close Others", async ({ page }) => {
  await openKafkaAndReact(page);
  const strip = tabStrip(page);
  await strip.getByRole("button", { name: "Kafka choice" }).click({ button: "right" });
  await page.getByRole("menu", { name: "tab actions" }).getByText("Close Others").click();
  await expect(strip.getByRole("button", { name: "React And Vite" })).toHaveCount(0);
  await expect(strip.getByRole("button", { name: "Kafka choice" })).toBeVisible();
});

test("hovering a tab shows a rich tooltip with the document's location and file", async ({
  page,
}) => {
  await openKafka(page);
  const tab = page.locator('[draggable="true"]').filter({ hasText: "Kafka choice" });
  await tab.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Kafka choice");
  await expect(tip).toContainText("kafka.md");
  const tabBox = await tab.boundingBox();
  const tipBox = await tip.boundingBox();
  expect(tipBox && tabBox && tipBox.y).toBeGreaterThanOrEqual(tabBox!.y + tabBox!.height / 2);
});

test("the tab context menu copies the canonical reference", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openKafka(page);
  await tabStrip(page).getByRole("button", { name: "Kafka choice" }).click({ button: "right" });
  await page.getByRole("menu", { name: "tab actions" }).getByText("Copy reference").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(KAFKA_REF);
});

test("Cmd+Shift+K opens the Ask dialog with its input focused", async ({ page }) => {
  await openKafka(page);
  await page.keyboard.press("Meta+Shift+KeyK");
  const input = page.getByPlaceholder("Ask your memory…");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
});

test("the tab context menu switches orientation to vertical, and it persists", async ({ page }) => {
  await openKafka(page);
  const strip = tabStrip(page);
  await strip.getByRole("button", { name: "Kafka choice" }).click({ button: "right" });
  await page.getByRole("menuitemradio", { name: /Vertical/ }).click();
  const heading = page.getByRole("heading", { name: "Kafka", level: 1 });
  const tabBox = await strip.getByRole("button", { name: "Kafka choice" }).boundingBox();
  const headingBox = await heading.boundingBox();
  expect(tabBox && headingBox && tabBox.x + tabBox.width).toBeLessThanOrEqual(headingBox!.x + 5);

  await page.reload();
  const tabBox2 = await tabStrip(page).getByRole("button", { name: "Kafka choice" }).boundingBox();
  const headingBox2 = await page.getByRole("heading", { name: "Kafka", level: 1 }).boundingBox();
  expect(tabBox2 && headingBox2 && tabBox2.x + tabBox2.width).toBeLessThanOrEqual(
    headingBox2!.x + 5,
  );
});

test("horizontal tabs wrap instead of scrolling sideways (Req 6)", async ({ page }) => {
  await openKafkaAndReact(page);
  const strip = tabStrip(page);
  await strip.getByRole("button", { name: "Kafka choice" }).click({ button: "right" });
  await page.getByRole("menuitemradio", { name: /Horizontal/ }).click();
  const style = await strip.evaluate((el) => {
    const s = getComputedStyle(el);
    return { flexWrap: s.flexWrap, overflowX: s.overflowX };
  });
  expect(style.flexWrap).toBe("wrap");
  expect(["auto", "scroll"]).not.toContain(style.overflowX);
});

test("the collapsed TOC/Related rail fills the viewport height (Req 1)", async ({ page }) => {
  await openKafka(page);
  const aside = page.locator("aside");
  await aside.getByRole("button", { name: "collapse TOC & Related Docs" }).click();
  const box = await aside.boundingBox();
  expect(box && box.height).toBeGreaterThan(400);
});

test("a backticked reference in a body renders as a wiki chip that keeps its monospace look", async ({
  page,
}) => {
  await openRefsDemo(page);
  const escalation = refChip(page, ESCALATION_REF);
  await expect(escalation).toBeVisible();
  await expect(escalation).toHaveAttribute("href", `#${ESCALATION_REF}`);
  await expect(escalation).toHaveAttribute("title", /Cmd-click/);
  await expect(escalation.locator("code")).toHaveText(ESCALATION_REF);
  expect(await escalation.getAttribute("target")).toBeNull();
  await expect(escalation).toHaveCSS("text-decoration-line", "none");
  const chipColor = await escalation.evaluate((el) => getComputedStyle(el).color);
  const externalColor = await externalLink(page).evaluate((el) => getComputedStyle(el).color);
  expect(chipColor).not.toBe(externalColor);
});

test("clicking a backticked reference opens the target document in a new app tab", async ({
  page,
}) => {
  await openRefsDemo(page);
  await closeTabNamed(page, "Kafka choice");
  const openedBefore = await tabItems(page).count();
  await refChip(page, KAFKA_REF).click();
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(refHash(KAFKA_ID));
  await expect(tabItems(page)).toHaveCount(openedBefore + 1);
  await expect(tabItems(page).filter({ hasText: "Kafka choice" })).toHaveCount(1);
  await expect(tabItems(page).filter({ hasText: "Reference Demo" })).toHaveCount(1);
});

test("clicking a reference to an already-open document focuses its existing tab", async ({
  page,
}) => {
  await openRefsDemo(page);
  await closeTabNamed(page, "Kafka choice");
  await refChip(page, KAFKA_REF).click();
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
  const openedBefore = await tabItems(page).count();
  await tabStrip(page).getByRole("button", { name: "Reference Demo" }).click();
  await expect(page.getByRole("heading", { name: "Reference Demo", level: 1 })).toBeVisible();
  await refChip(page, KAFKA_REF).click();
  await expect(page).toHaveURL(refHash(KAFKA_ID));
  await expect(tabItems(page)).toHaveCount(openedBefore);
  await expect(tabItems(page).filter({ hasText: "Kafka choice" })).toHaveCount(1);
});

test("an ordinary http link opens a browser tab and leaves the app where it was", async ({
  page,
}) => {
  await openRefsDemo(page);
  const link = externalLink(page);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const openedBefore = await tabItems(page).count();
  const [opened] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await expect.poll(() => opened.url()).toContain("example.com");
  await opened.close();
  await expect(page).toHaveURL(refHash(REFS_DEMO_ID));
  await expect(page.getByRole("heading", { name: "Reference Demo", level: 1 })).toBeVisible();
  await expect(tabItems(page)).toHaveCount(openedBefore);
});

test("Cmd-clicking a wiki reference opens a browser tab landing on the target document", async ({
  page,
  context,
}) => {
  await openRefsDemo(page);
  await closeTabNamed(page, "Kafka choice");
  const openedBefore = await tabItems(page).count();
  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    refChip(page, KAFKA_REF).click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await opened.bringToFront();
  await expect(opened).toHaveURL(refHash(KAFKA_ID), { timeout: 20000 });
  await expect(opened.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible({
    timeout: 20000,
  });
  await opened.close();
  await page.bringToFront();
  await expect(page.getByRole("heading", { name: "Reference Demo", level: 1 })).toBeVisible();
  await expect(tabItems(page)).toHaveCount(openedBefore);
});

test("a definition-token occurrence scrolls to the row that defines it", async ({ page }) => {
  await openRefsDemo(page);
  const occurrence = page.locator('.md-body a[data-def-token="E1"]');
  await expect(occurrence).toHaveCount(1);
  await expect(occurrence).toHaveAttribute("href", "#def-e1");
  const definition = page.locator("#def-e1");
  await expect(definition).toHaveText("E1");
  await expect(definition).not.toBeInViewport();
  await occurrence.click();
  await expect(definition).toHaveClass(/def-token-flash/);
  await expect(definition).toBeInViewport();
  await expect(page).toHaveURL(refHash(REFS_DEMO_ID));
});
