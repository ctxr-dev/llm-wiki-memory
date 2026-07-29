import { test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LeafCard } from "./LeafCard";

afterEach(() => cleanup());

test("renders a colored priority badge when the summary carries one", () => {
  render(<LeafCard title="Kafka" name="kafka.md" summary={{ priority: "P0" }} />);
  const badge = screen.getByText("P0");
  expect(badge.className).toContain("bg-red-100");
});

test("omits the priority row when the summary has no priority", () => {
  render(<LeafCard title="Kafka" name="kafka.md" summary={{ area: "backend" }} />);
  expect(screen.queryByText("Priority")).toBeNull();
});
