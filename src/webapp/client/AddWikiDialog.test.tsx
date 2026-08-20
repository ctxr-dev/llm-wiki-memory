import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddWikiDialog, addErrorText } from "./AddWikiDialog";

const respond = (ok: boolean, status: number, body: unknown) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as unknown as Response);

function setClipboard(readText: () => Promise<string>) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { readText },
    configurable: true,
  });
}

function renderDialog(onClose = vi.fn(), onAdded = vi.fn()) {
  render(<AddWikiDialog onClose={onClose} onAdded={onAdded} />);
  return { onClose, onAdded };
}

const input = () => screen.getByPlaceholderText(/absolute\/path/) as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

test("the paste button fills the input from the clipboard (trimmed)", async () => {
  setClipboard(() => Promise.resolve("  /pasted/wiki  "));
  renderDialog();
  fireEvent.click(screen.getByLabelText("paste from clipboard"));
  await waitFor(() => expect(input().value).toBe("/pasted/wiki"));
});

test("a clipboard-read failure surfaces a friendly error", async () => {
  setClipboard(() => Promise.reject(new Error("denied")));
  renderDialog();
  fireEvent.click(screen.getByLabelText("paste from clipboard"));
  await waitFor(() => expect(screen.getByText(/Couldn't read the clipboard/)).toBeTruthy());
});

test("the Choose folder button fills the input with the natively picked path", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      String(url) === "/api/pick-folder" && (init as RequestInit)?.method === "POST"
        ? respond(true, 200, { path: "/native/picked" })
        : respond(true, 200, {}),
    ),
  );
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
  await waitFor(() => expect(input().value).toBe("/native/picked"));
});

test("an unsupported platform shows a macOS-only hint (paste instead)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      String(url) === "/api/pick-folder" && (init as RequestInit)?.method === "POST"
        ? respond(false, 501, { error: "unsupported" })
        : respond(true, 200, {}),
    ),
  );
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
  await waitFor(() => expect(screen.getByText(/only available on macOS/)).toBeTruthy());
});

test("a generic pick-folder failure shows the fallback error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      String(url) === "/api/pick-folder" && (init as RequestInit)?.method === "POST"
        ? respond(false, 500, { error: "pick-failed" })
        : respond(true, 200, {}),
    ),
  );
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
  await waitFor(() => expect(screen.getByText(/Couldn't open the folder picker/)).toBeTruthy());
});

test("an empty clipboard is a silent no-op (no error, input untouched)", async () => {
  setClipboard(() => Promise.resolve("   "));
  renderDialog();
  fireEvent.click(screen.getByLabelText("paste from clipboard"));
  await Promise.resolve();
  expect(input().value).toBe("");
  expect(screen.queryByText(/clipboard/i)).toBeNull();
});

test("addErrorText maps known codes and falls back for the rest", () => {
  expect(addErrorText("not-a-wiki")).toMatch(/No .llm-wiki-memory found/);
  expect(addErrorText("not-absolute")).toMatch(/absolute path/);
  expect(addErrorText("is-home")).toMatch(/home wiki/);
  expect(addErrorText("invalid-request")).toMatch(/folder path/);
  expect(addErrorText("something-unexpected")).toBe("Couldn't add that folder.");
});

test("a canceled native pick (empty path) leaves the input untouched", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      String(url) === "/api/pick-folder" && (init as RequestInit)?.method === "POST"
        ? respond(true, 200, { path: "" })
        : respond(true, 200, {}),
    ),
  );
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Choose folder/ }).textContent).toMatch(
      /Choose folder/,
    ),
  );
  expect(input().value).toBe("");
});

const WIKI = {
  id: "repo1",
  kind: "added",
  root: "/rr",
  mountDir: "/repo",
  projectModule: "repo",
  ownership: "repo",
  label: "Repo",
  categories: ["shared_notes"],
};

test("submitting the path adds the wiki, refreshes, and closes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      String(url) === "/api/wikis" && (init as RequestInit)?.method === "POST"
        ? respond(true, 200, { wiki: WIKI })
        : respond(true, 200, {}),
    ),
  );
  const onAdded = vi.fn();
  const { onClose } = renderDialog(vi.fn(), onAdded);
  fireEvent.change(input(), { target: { value: "/repo" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(onAdded).toHaveBeenCalled());
  expect(onClose).toHaveBeenCalled();
});

test("Escape and the close button both dismiss the dialog", () => {
  const { onClose } = renderDialog();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByLabelText("close"));
  expect(onClose).toHaveBeenCalledTimes(2);
});
