import { test, expect } from "@playwright/test";

const DOC = "brain:investigations/general/rich-html-demo.md";

type Page = import("@playwright/test").Page;

const viewer = (page: Page) => page.getByRole("dialog", { name: "diagram" });
const level = async (page: Page) =>
  Number((await viewer(page).getByText(/%$/).textContent())?.replace("%", ""));

async function openDoc(page: Page) {
  await page.goto(`/#${DOC}`);
  await expect(page.getByRole("heading", { name: "Rich Html Demo", level: 1 })).toBeVisible({
    timeout: 20000,
  });
}

test("an inline svg renders as a real drawing, gradient reference intact", async ({ page }) => {
  await openDoc(page);
  const svg = page.locator("[data-diagram-preview] svg").first();
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute("viewBox", "0 0 200 100");
  await expect(page.locator("linearGradient")).toHaveAttribute("id", "grad");
  await expect(page.locator("rect[rx]")).toHaveAttribute("fill", "url(#grad)");
  const painted = await page
    .locator("rect[rx]")
    .evaluate((node) => node.getBoundingClientRect().width);
  expect(painted).toBeGreaterThan(0);
});

test("a small diagram opens filling the window rather than staying small", async ({ page }) => {
  await openDoc(page);
  const preview = page.locator("[data-diagram-preview]").first();
  await preview.hover();
  await page.getByRole("button", { name: "open diagram full screen" }).first().click();
  await expect(viewer(page)).toBeVisible();

  await expect.poll(() => level(page)).toBeGreaterThan(100);

  const svg = viewer(page).locator("[data-diagram-full] svg").first();
  const box = await svg.boundingBox();
  const size = page.viewportSize();
  expect(box).not.toBeNull();
  expect(size).not.toBeNull();

  const widthUsed = (box?.width ?? 0) / (size?.width ?? 1);
  const heightUsed = (box?.height ?? 0) / (size?.height ?? 1);
  expect(Math.max(widthUsed, heightUsed)).toBeGreaterThan(0.8);
  expect(box?.width ?? 0).toBeLessThanOrEqual((size?.width ?? 0) + 1);
  expect(box?.height ?? 0).toBeLessThanOrEqual((size?.height ?? 0) + 1);
});

test("rich html blocks render and keep their author classes", async ({ page }) => {
  await openDoc(page);
  await expect(page.locator("section.rich-block")).toBeVisible();
  await expect(page.locator("figcaption")).toHaveText("A caption");
  await expect(page.getByText("Show more")).toBeVisible();
});

test("a script in a leaf neither runs nor appears as text", async ({ page }) => {
  await openDoc(page);
  const ran = await page.evaluate(() => (window as unknown as Record<string, unknown>).__xssRan);
  expect(ran).toBeUndefined();
  await expect(page.locator("script#none")).toHaveCount(0);
  await expect(page.getByText("__xssRan")).toHaveCount(0);
});

test("a container marked as a diagram gets its own viewer", async ({ page }) => {
  await openDoc(page);
  await expect(page.getByText("opted in by class")).toBeVisible();
  const controls = page.getByRole("button", { name: "open diagram full screen" });
  expect(await controls.count()).toBeGreaterThanOrEqual(2);
});
