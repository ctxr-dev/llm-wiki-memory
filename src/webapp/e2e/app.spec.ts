import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function openKafka(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByText("Categories")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: /^Knowledge/ }).click();
  await page.getByRole("button", { name: /^Backend/ }).click();
  await page.getByRole("button", { name: /^Decision/ }).click();
  await page.getByRole("button", { name: /^Architecture/ }).click();
  await page.getByRole("button", { name: "kafka.md" }).click();
}

test("renders a document with markdown, a table, and a code block", async ({ page }) => {
  await openKafka(page);
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("cell", { name: "RabbitMQ" })).toBeVisible();
  await expect(page.getByText('const topic = "events";')).toBeVisible();
});

test("command palette (⌘K) searches and opens a result", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Categories")).toBeVisible({ timeout: 20000 });
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder(/Search or jump/);
  await expect(input).toBeVisible();
  await input.fill("kafka");
  const result = page.getByRole("button").filter({ hasText: "kafka.md" });
  await expect(result.first()).toBeVisible({ timeout: 15000 });
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "Kafka", level: 1 })).toBeVisible();
});

test("the Lexical editor opens for a document", async ({ page }) => {
  await openKafka(page);
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText(/Editing/)).toBeVisible();
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
});

test("the Plans board shows plan cards in lifecycle columns", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Categories")).toBeVisible({ timeout: 20000 });
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
