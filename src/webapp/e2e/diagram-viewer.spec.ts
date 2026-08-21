import { test, expect } from "@playwright/test";

const DIAGRAM_REF = "brain:investigations/general/diagram-demo.md";

type Page = import("@playwright/test").Page;

async function openDiagramDoc(page: Page) {
  await page.goto(`/#${DIAGRAM_REF}`);
  await expect(page.getByRole("heading", { name: "Diagram Demo", level: 1 })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator("[data-diagram-preview] svg")).toBeVisible({ timeout: 20000 });
}

const expand = (page: Page) => page.getByRole("button", { name: "open diagram full screen" });
const viewer = (page: Page) => page.getByRole("dialog", { name: "diagram" });
const level = async (page: Page) =>
  Number((await viewer(page).getByText(/%$/).textContent())?.replace("%", ""));

test("a rendered diagram reveals its expand control on hover", async ({ page }) => {
  await openDiagramDoc(page);
  await expect(expand(page)).toHaveCSS("opacity", "0");
  await page.locator("[data-diagram-preview]").hover();
  await expect(expand(page)).toHaveCSS("opacity", "1");
});

test("opening a wide diagram fits it into the window instead of clipping it", async ({ page }) => {
  await openDiagramDoc(page);
  await page.locator("[data-diagram-preview]").hover();
  await expand(page).click();
  await expect(viewer(page)).toBeVisible();
  expect(await level(page)).toBeLessThan(100);
  const svg = viewer(page).locator("svg").first();
  const box = await svg.boundingBox();
  const size = page.viewportSize();
  expect(box).not.toBeNull();
  expect(size).not.toBeNull();
  expect((box?.width ?? 0) - 1).toBeLessThanOrEqual(size?.width ?? 0);
});

test("the viewer zooms in, out, and back to fit", async ({ page }) => {
  await openDiagramDoc(page);
  await page.locator("[data-diagram-preview]").hover();
  await expand(page).click();
  await expect.poll(() => level(page)).toBeLessThan(100);
  const fitted = await level(page);
  await viewer(page).getByRole("button", { name: "zoom in" }).click();
  await expect.poll(() => level(page)).toBeGreaterThan(fitted);
  await viewer(page).getByRole("button", { name: "fit to window" }).click();
  await expect.poll(() => level(page)).toBe(fitted);
});

test("a zoomed diagram scrolls with the wheel, and ctrl+wheel zooms instead", async ({ page }) => {
  await openDiagramDoc(page);
  await page.locator("[data-diagram-preview]").hover();
  await expand(page).click();
  const zoomIn = viewer(page).getByRole("button", { name: "zoom in" });
  for (let i = 0; i < 8; i += 1) await zoomIn.click();

  const scroller = viewer(page).locator("div.overflow-auto").first();
  await scroller.hover();
  const offsets = () => scroller.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  const overflow = await scroller.evaluate((el) => ({
    y: el.scrollHeight > el.clientHeight,
    x: el.scrollWidth > el.clientWidth,
  }));
  expect(overflow.y).toBe(true);
  expect(overflow.x).toBe(true);

  const start = await offsets();
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await offsets()).y).toBeGreaterThan(start.y);

  const zoomed = await level(page);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect.poll(() => level(page)).toBeGreaterThan(zoomed);
});

test("escape and the close button both dismiss the viewer", async ({ page }) => {
  await openDiagramDoc(page);
  await page.locator("[data-diagram-preview]").hover();
  await expand(page).click();
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toBeHidden();

  await page.locator("[data-diagram-preview]").hover();
  await expand(page).click();
  await viewer(page).getByRole("button", { name: "close diagram" }).click();
  await expect(viewer(page)).toBeHidden();
});

test("the diagram can be dragged with the mouse, and the cursor shows the grab state", async ({
  page,
}) => {
  await openDiagramDoc(page);
  await page.locator("[data-diagram-preview]").hover();
  await expand(page).click();
  const zoomIn = viewer(page).getByRole("button", { name: "zoom in" });
  for (let i = 0; i < 8; i += 1) await zoomIn.click();

  const scroller = viewer(page).locator("div.overflow-auto").first();
  await expect(scroller).toHaveCSS("cursor", "grab");
  const offsets = () => scroller.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));

  const box = await scroller.boundingBox();
  const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await expect(scroller).toHaveCSS("cursor", "grabbing");
  const start = await offsets();
  await page.mouse.move(cx - 180, cy - 120, { steps: 6 });
  await expect.poll(async () => (await offsets()).x).toBeGreaterThan(start.x);
  expect((await offsets()).y).toBeGreaterThan(start.y);
  await page.mouse.up();
  await expect(scroller).toHaveCSS("cursor", "grab");
});

test("a raw-HTML topology tree opens in the viewer and is fitted", async ({ page }) => {
  await page.goto("/#brain:investigations/general/refs-demo.md");
  await expect(page.getByRole("heading", { name: "Reference Demo", level: 1 })).toBeVisible({
    timeout: 20000,
  });
  const tree = page.locator("pre[data-diagram-preview]").first();
  await expect(tree).toBeVisible();
  await tree.hover();
  await page.getByRole("button", { name: "open diagram full screen" }).first().click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).locator("pre[data-diagram-full]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toBeHidden();
});
