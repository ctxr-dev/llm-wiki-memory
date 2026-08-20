import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "./TabBar";

const draggableOf = (label: string) =>
  screen.getByText(label).closest("[draggable]") as HTMLElement;

test("clicking a tab selects it; clicking its close button closes it", () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <TabBar
      tabs={["a", "b"]}
      active="a"
      labelFor={(id) => id}
      onSelect={onSelect}
      onClose={onClose}
      onReorder={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("b"));
  expect(onSelect).toHaveBeenCalledWith("b");
  fireEvent.click(screen.getAllByLabelText("close tab")[0]);
  expect(onClose).toHaveBeenCalledWith("a");
});

test("dragging one tab onto another reorders and notifies with the new order", () => {
  const onReorder = vi.fn();
  render(
    <TabBar
      tabs={["a", "b", "c"]}
      active="a"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={onReorder}
    />,
  );
  fireEvent.dragStart(draggableOf("a"));
  fireEvent.dragOver(draggableOf("c"));
  fireEvent.drop(draggableOf("c"));
  expect(onReorder).toHaveBeenCalledWith(["b", "c", "a"]);
});

test("dropping a tab onto itself does not reorder", () => {
  const onReorder = vi.fn();
  render(
    <TabBar
      tabs={["a", "b"]}
      active="a"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={onReorder}
    />,
  );
  fireEvent.dragStart(draggableOf("a"));
  fireEvent.drop(draggableOf("a"));
  expect(onReorder).not.toHaveBeenCalled();
});

test("right-clicking a tab reports the target and cursor coordinates", () => {
  const onContextMenu = vi.fn();
  render(
    <TabBar
      tabs={["a", "b"]}
      active="a"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      onContextMenu={onContextMenu}
    />,
  );
  fireEvent.contextMenu(draggableOf("b"), { clientX: 42, clientY: 99 });
  expect(onContextMenu).toHaveBeenCalledWith("b", 42, 99);
});

test("vertical orientation stacks tabs in a column (no wrap row)", () => {
  const { container } = render(
    <TabBar
      tabs={["a"]}
      active="a"
      orientation="vertical"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
    />,
  );
  const strip = container.firstChild as HTMLElement;
  expect(strip.className).toContain("flex-col");
  expect(strip.className).not.toContain("flex-wrap");
});

test("the strip wraps (Req 6) rather than scrolling horizontally", () => {
  const { container } = render(
    <TabBar
      tabs={["a"]}
      active="a"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
    />,
  );
  const strip = container.firstChild as HTMLElement;
  expect(strip.className).toContain("flex-wrap");
  expect(strip.className).not.toContain("overflow-x-auto");
});

test("a drop indicator appears at the drag-over target and clears when the drag ends", () => {
  const { container } = render(
    <TabBar
      tabs={["a", "b", "c"]}
      active="a"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
    />,
  );
  expect(container.querySelector("[data-drop-indicator]")).toBeNull();
  fireEvent.dragStart(draggableOf("a"));
  fireEvent.dragOver(draggableOf("c"));
  expect(container.querySelector("[data-drop-indicator]")).toBeTruthy();
  fireEvent.dragEnd(draggableOf("a"));
  expect(container.querySelector("[data-drop-indicator]")).toBeNull();
});

test("vertical tabs truncate the label to fit the column (no overflow)", () => {
  render(
    <TabBar
      tabs={["knowledge/a/very/long/document/title/that/would/overflow.md"]}
      active="knowledge/a/very/long/document/title/that/would/overflow.md"
      orientation="vertical"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
    />,
  );
  const label = screen.getByText(/would\/overflow\.md/);
  expect(label.className).toContain("truncate");
  expect(label.closest("button")?.className).toContain("w-full");
});

test("shows an archive icon only on archived tabs", () => {
  render(
    <TabBar
      tabs={["knowledge/a.md", "knowledge/b.md"]}
      active="knowledge/a.md"
      archivedIds={["knowledge/b.md"]}
      labelFor={(id) => id.split("/").pop() ?? id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
    />,
  );
  expect(screen.getAllByLabelText("archived")).toHaveLength(1);
});

test("the close button is in the DOM but hover-revealed (not always visible)", () => {
  render(
    <TabBar
      tabs={["a"]}
      active="a"
      labelFor={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
    />,
  );
  const close = screen.getByLabelText("close tab");
  expect(close.className).toContain("opacity-0");
  expect(close.className).toContain("group-hover:opacity-100");
});
