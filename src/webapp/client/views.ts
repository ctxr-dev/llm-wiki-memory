export type MainView = "docs" | "plans" | "issues";

/**
 * The board views a wiki exposes, following its layout. "docs" is always present;
 * "plans" / "issues" appear only when the wiki declares that category, so a wiki
 * whose layout omits them never shows a dead tab.
 */
export function availableViews(categories: string[] | undefined): MainView[] {
  const views: MainView[] = ["docs"];
  if (categories?.includes("plans")) views.push("plans");
  if (categories?.includes("issues")) views.push("issues");
  return views;
}
