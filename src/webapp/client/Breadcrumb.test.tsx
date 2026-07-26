import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Breadcrumb } from "./Breadcrumb";
import type { Wiki } from "./api";

const brain: Wiki = {
  id: "home-id",
  kind: "home",
  root: "/ws/.llm-wiki-memory/wiki",
  mountDir: "/ws",
  projectModule: "ws-default-module",
  ownership: "wiki",
  label: "Main Brain",
  categories: ["knowledge"],
};

const repo: Wiki = {
  id: "repo-id",
  kind: "added",
  root: "/ws/repos/widget/.llm-wiki-memory/wiki",
  mountDir: "/ws/repos/widget",
  projectModule: "acme/widget",
  ownership: "repo",
  label: "Widget",
  categories: ["knowledge"],
};

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

test("copies brain:<docId> for the home wiki", async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  setClipboard(writeText);
  render(<Breadcrumb docId="knowledge/infra/foo.md" wiki={brain} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("copy reference"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("brain:knowledge/infra/foo.md"));
});

test("copies <projectModule>:<docId> for a repo wiki (derived from the fixture, not hardcoded)", async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  setClipboard(writeText);
  render(<Breadcrumb docId="knowledge/bar.md" wiki={repo} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("copy reference"));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(`${repo.projectModule}:knowledge/bar.md`),
  );
});

test("shows a transient copied state after a successful copy", async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  setClipboard(writeText);
  render(<Breadcrumb docId="knowledge/foo.md" wiki={brain} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("copy reference"));
  await waitFor(() => expect(screen.getByLabelText("reference copied")).toBeTruthy());
});

test("renders no copy button until the active wiki is known", () => {
  render(<Breadcrumb docId="knowledge/foo.md" onNavigate={vi.fn()} />);
  expect(screen.queryByLabelText("copy reference")).toBeNull();
});

test("clicking copy is a safe no-op when the clipboard API is unavailable", () => {
  render(<Breadcrumb docId="knowledge/foo.md" wiki={brain} onNavigate={vi.fn()} />);
  expect(() => fireEvent.click(screen.getByLabelText("copy reference"))).not.toThrow();
  expect(screen.queryByLabelText("reference copied")).toBeNull();
});

test("a clipboard write failure neither throws nor shows the copied state", async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
  setClipboard(writeText);
  render(<Breadcrumb docId="knowledge/foo.md" wiki={brain} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("copy reference"));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(screen.queryByLabelText("reference copied")).toBeNull();
});
