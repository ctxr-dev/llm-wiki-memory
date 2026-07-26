import { test, expect } from "@playwright/test";
import { palette, openCategories, openKafka } from "./helpers";

const KAFKA_ID = "knowledge/backend/decision/architecture/kafka.md";
const KAFKA_REF = `brain:${KAFKA_ID}`;

const tabStrip = (page: import("@playwright/test").Page) =>
  page.locator('div:has(> [draggable="true"])');

async function openKafkaAndReact(page: import("@playwright/test").Page) {
  await openKafka(page);
  await page.locator("aside").getByRole("button", { name: "React And Vite" }).click();
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
  await expect(palette(page).getByText("Reference")).toBeVisible();
  await palette(page).getByText(KAFKA_ID).click();
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
