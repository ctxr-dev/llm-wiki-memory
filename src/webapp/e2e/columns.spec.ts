import { test, expect } from "@playwright/test";
import { tree, openCategories, openKafka } from "./helpers";

test("the Wikis and Categories columns collapse to a rail and expand back", async ({ page }) => {
  await openCategories(page);

  const wikis = page.getByRole("navigation", { name: "wikis" });
  await expect(wikis.getByRole("button", { name: "Add wiki" })).toBeVisible();
  await wikis.getByRole("button", { name: "collapse Wikis" }).click();
  await expect(wikis.getByRole("button", { name: "Add wiki" })).toBeHidden();
  await expect(wikis.getByRole("button", { name: "expand Wikis" })).toBeVisible();
  await wikis.getByRole("button", { name: "expand Wikis" }).click();
  await expect(wikis.getByRole("button", { name: "Add wiki" })).toBeVisible();

  const browse = page.getByRole("navigation", { name: "browse" });
  await expect(browse.getByRole("button", { name: /^Knowledge/ })).toBeVisible();
  await browse.getByRole("button", { name: "collapse Categories" }).click();
  await expect(browse.getByRole("button", { name: /^Knowledge/ })).toBeHidden();
  await expect(browse.getByRole("button", { name: "expand Categories" })).toBeVisible();
  await browse.getByRole("button", { name: "expand Categories" }).click();
  await expect(browse.getByRole("button", { name: /^Knowledge/ })).toBeVisible();
});

test("the collapsed Categories rail shows the current path (breadcrumb words)", async ({
  page,
}) => {
  await openCategories(page);
  await tree(page)
    .getByRole("button", { name: /^Knowledge/ })
    .click();
  const browse = page.getByRole("navigation", { name: "browse" });
  await browse.getByRole("button", { name: "collapse Categories" }).click();
  await expect(browse.getByText("Knowledge")).toBeVisible();
});

test("the view tabs follow the wiki layout (plans present, issues absent)", async ({ page }) => {
  await openCategories(page);
  await expect(page.getByRole("button", { name: "plans", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "issues", exact: true })).toHaveCount(0);
});

test("on a medium screen the Wikis column collapses first while Categories stays open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openCategories(page);
  await expect(
    page.getByRole("navigation", { name: "wikis" }).getByRole("button", { name: "expand Wikis" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "browse" }).getByRole("button", { name: /^Knowledge/ }),
  ).toBeVisible();
});

test("selecting a wiki on a small screen expands the collapsed Categories column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await openCategories(page);
  const wikis = page.getByRole("navigation", { name: "wikis" });
  const browse = page.getByRole("navigation", { name: "browse" });
  await expect(browse.getByRole("button", { name: "expand Categories" })).toBeVisible();
  await wikis.getByRole("button", { name: "expand Wikis" }).click();
  await wikis.getByRole("button").filter({ hasText: "home" }).click();
  await expect(browse.getByRole("button", { name: /^Knowledge/ })).toBeVisible();
});

test("the TOC & Related column collapses to a rail and expands back", async ({ page }) => {
  await openKafka(page);
  const aside = page.locator("aside");
  const related = aside.getByRole("button", { name: "React And Vite" });
  await expect(related).toBeVisible({ timeout: 15000 });
  await aside.getByRole("button", { name: "collapse TOC & Related Docs" }).click();
  await expect(related).toBeHidden();
  await expect(aside.getByRole("button", { name: "expand TOC & Related Docs" })).toBeVisible();
  await aside.getByRole("button", { name: "expand TOC & Related Docs" }).click();
  await expect(related).toBeVisible();
});
