import { test, expect } from "@playwright/test";

const REAL_ID = "issues/JIRA/DEV/134/9/6/pending/DEV-134096-moved-demo.plan.md";
const STALE_ID = "issues/JIRA/DEV/134/9/6/in-progress/DEV-134096-moved-demo.plan.md";

const hashOf = (docId: string) => new RegExp(`#brain:${docId.replace(/[/.]/g, "\\$&")}$`);

const tabNamed = (page: import("@playwright/test").Page, label: string) =>
  page.locator('[draggable="true"]').filter({ hasText: label });

test("a reference naming a plan's old lifecycle folder opens the plan and reports the swap", async ({
  page,
}) => {
  await page.goto(`/#brain:${STALE_ID}`);
  await expect(page.getByRole("heading", { name: "Moved Demo", level: 1 })).toBeVisible({
    timeout: 20000,
  });
  const notice = page.getByRole("status");
  await expect(notice).toContainText(STALE_ID);
  await expect(notice).toContainText(REAL_ID);
  await expect(page).toHaveURL(hashOf(REAL_ID));
  await expect(tabNamed(page, "Moved Demo Plan")).toHaveCount(1);
});

test("opening the plan at its real id shows no swap notice", async ({ page }) => {
  await page.goto(`/#brain:${REAL_ID}`);
  await expect(page.getByRole("heading", { name: "Moved Demo", level: 1 })).toBeVisible({
    timeout: 20000,
  });
  await expect(page).toHaveURL(hashOf(REAL_ID));
  await expect(page.getByRole("status")).toHaveCount(0);
});
