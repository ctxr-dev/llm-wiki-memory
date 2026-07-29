import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { EditorPanel } from "./EditorPanel";

const { archiveDoc, editDoc, deleteDoc } = vi.hoisted(() => ({
  archiveDoc: vi.fn(),
  editDoc: vi.fn(),
  deleteDoc: vi.fn(),
}));
vi.mock("./api", () => ({ api: { archiveDoc, editDoc, deleteDoc } }));
vi.mock("./Editor", () => ({ Editor: () => <div data-testid="editor" /> }));
vi.mock("./FrontmatterForm", () => ({ FrontmatterForm: () => <div data-testid="fmform" /> }));
vi.mock("./DiffView", () => ({ DiffView: () => <div data-testid="diff" /> }));

const DOC = {
  id: "doc1",
  name: "note.md",
  body: "# Note\n\nbody",
  memory: {},
  category: "knowledge",
  active: true,
};

function renderPanel(doc = DOC, onDone = vi.fn(), onDeleted = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EditorPanel wikiId="w1" doc={doc as never} onDone={onDone} onDeleted={onDeleted} />
    </QueryClientProvider>,
  );
  return { onDone, onDeleted };
}

beforeEach(() => {
  archiveDoc.mockResolvedValue({ ok: true });
  editDoc.mockResolvedValue({ ok: true, id: "doc1" });
  deleteDoc.mockResolvedValue({ ok: true });
});
afterEach(() => {
  archiveDoc.mockReset();
  editDoc.mockReset();
  deleteDoc.mockReset();
});

test("Archive opens a confirmation dialog; confirming archives", async () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/Archive this document/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(archiveDoc).toHaveBeenCalledWith("w1", "doc1", true));
});

test("canceling the archive confirmation does NOT archive", async () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(archiveDoc).not.toHaveBeenCalled();
});

test("Restore is not destructive — it toggles directly with no confirmation", async () => {
  renderPanel({ ...DOC, active: false });
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(archiveDoc).toHaveBeenCalledWith("w1", "doc1", false));
  expect(screen.queryByText(/Archive this document/)).toBeNull();
});

test("Delete requires typing 'delete', then deletes and signals onDeleted", async () => {
  const { onDeleted } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(within(dialog).getByPlaceholderText("delete"), { target: { value: "delete" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => expect(deleteDoc).toHaveBeenCalledWith("w1", "doc1"));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
});

test("Save… opens the diff modal and Save persists the edit", async () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Save…" }));
  expect(await screen.findByText("Review changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(editDoc).toHaveBeenCalled());
});

test("a self_improvement edit gates Save behind the consent checkbox", async () => {
  renderPanel({ ...DOC, category: "self_improvement" });
  fireEvent.click(screen.getByRole("button", { name: "Save…" }));
  const dialog = await screen.findByRole("dialog");
  const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("checkbox"));
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() =>
    expect(editDoc).toHaveBeenCalledWith(
      "w1",
      "doc1",
      expect.objectContaining({ userRequested: true }),
    ),
  );
});
