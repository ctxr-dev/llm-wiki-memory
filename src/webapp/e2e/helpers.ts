import { expect } from "@playwright/test";

type Page = import("@playwright/test").Page;
type Locator = import("@playwright/test").Locator;

export const tree = (page: Page): Locator => page.getByRole("navigation", { name: "browse" });
export const palette = (page: Page): Locator => page.getByRole("dialog", { name: "search" });

export async function openCategories(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Categories")).toBeVisible({ timeout: 20000 });
}

export async function drillToArchitecture(page: Page, area: RegExp) {
  const browse = tree(page);
  await browse.getByRole("button", { name: /^Knowledge/ }).click();
  await browse.getByRole("button", { name: area }).click();
  await browse.getByRole("button", { name: /^Decision/ }).click();
  await browse.getByRole("button", { name: /^Architecture/ }).click();
}

export async function openKafka(page: Page) {
  await openCategories(page);
  await drillToArchitecture(page, /^Backend/);
  await tree(page).getByRole("button", { name: "Kafka choice" }).click();
}

export async function openReact(page: Page) {
  await openCategories(page);
  await drillToArchitecture(page, /^Frontend/);
  await tree(page).getByRole("button", { name: "React And Vite" }).click();
}
