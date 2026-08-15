import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PartialResultsNotice } from "./PartialResultsNotice";
import { api } from "./api";

const partial = { skippedLeaves: 9, embeddedTexts: 8, remedy: "Run `cli.mjs warm`." };

beforeEach(() => {
  vi.restoreAllMocks();
});

/**
 * The no-false-positive property, mirrored from the MCP side: a complete result set must look
 * exactly as it did before, or the notice becomes background noise people learn to ignore.
 */
test("renders NOTHING on a complete result set", () => {
  const { container } = render(<PartialResultsNotice wikiId="w1" partial={undefined} />);
  expect(container.innerHTML).toBe("");
});

test("renders nothing when zero leaves were skipped", () => {
  const { container } = render(
    <PartialResultsNotice wikiId="w1" partial={{ ...partial, skippedLeaves: 0 }} />,
  );
  expect(container.innerHTML).toBe("");
});

test("states the count and that results were left out", () => {
  render(<PartialResultsNotice wikiId="w1" partial={partial} />);
  const notice = screen.getByRole("status");
  expect(notice.textContent).toMatch(/partial results/i);
  expect(notice.textContent).toMatch(/9 notes/);
  expect(notice.textContent).toMatch(/left out/i);
});

test("singular wording for one leaf — it is user-facing prose, not a debug line", () => {
  render(<PartialResultsNotice wikiId="w1" partial={{ ...partial, skippedLeaves: 1 }} />);
  const text = screen.getByRole("status").textContent ?? "";
  expect(text).toMatch(/1 note has/);
  expect(text).not.toMatch(/notes have/);
});

test("the button starts a warm for the current wiki", async () => {
  const warm = vi.spyOn(api, "warm").mockResolvedValue({ started: true });
  render(<PartialResultsNotice wikiId="w42" partial={partial} />);
  fireEvent.click(screen.getByRole("button", { name: /warm now/i }));
  await waitFor(() => expect(warm).toHaveBeenCalledWith("w42"));
  await waitFor(() => expect(screen.getByText(/warming/i)).toBeTruthy());
});

/**
 * A warm already in flight is the SAME outcome for the user: the corpus is being embedded. Showing
 * an error there would be misleading.
 */
test("an already-running warm reads as success, not failure", async () => {
  vi.spyOn(api, "warm").mockResolvedValue({ started: false, reason: "already-running" });
  render(<PartialResultsNotice wikiId="w1" partial={partial} />);
  fireEvent.click(screen.getByRole("button", { name: /warm now/i }));
  await waitFor(() => expect(screen.getByText(/warming/i)).toBeTruthy());
});

test("a failed warm offers a retry rather than dead-ending", async () => {
  vi.spyOn(api, "warm").mockRejectedValue(new Error("boom"));
  render(<PartialResultsNotice wikiId="w1" partial={partial} />);
  fireEvent.click(screen.getByRole("button", { name: /warm now/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /retry warm/i })).toBeTruthy());
});

test("the button is disabled with no wiki selected", () => {
  render(<PartialResultsNotice wikiId={null} partial={partial} />);
  const btn = screen.getByRole("button", { name: /warm now/i }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
});

test("a double-click does not fire two warms", async () => {
  const warm = vi.spyOn(api, "warm").mockResolvedValue({ started: true });
  render(<PartialResultsNotice wikiId="w1" partial={partial} />);
  const btn = screen.getByRole("button", { name: /warm now/i });
  fireEvent.click(btn);
  fireEvent.click(btn);
  await waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
});
