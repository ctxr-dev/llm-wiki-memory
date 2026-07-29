import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FrontmatterCard } from "./FrontmatterCard";
import type { DocView } from "./api";

const doc: DocView = {
  id: "knowledge/backend/decision/architecture/kafka.md",
  name: "kafka.md",
  category: "knowledge",
  body: "x",
  frontmatter: { focus: "kafka" },
  memory: { area: "backend", atom_type: "decision", subject: ["architecture"], priority: "P1" },
  active: true,
};

test("shows facet chips and toggles the raw frontmatter", () => {
  render(<FrontmatterCard doc={doc} />);
  expect(screen.getByText(/Backend/)).toBeTruthy();
  expect(screen.getByText(/Decision/)).toBeTruthy();
  expect(screen.getByText(/Architecture/)).toBeTruthy();
  expect(screen.getByText(/P1/)).toBeTruthy();
  expect(screen.queryByText(/"focus"/)).toBeNull();
  fireEvent.click(screen.getByText("frontmatter"));
  expect(screen.getByText(/"focus": "kafka"/)).toBeTruthy();
});
