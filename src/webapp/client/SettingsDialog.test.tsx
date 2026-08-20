import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => cleanup());

test("reflects the current state and toggles on click", () => {
  const onToggle = vi.fn();
  const { rerender } = render(
    <SettingsDialog showArchived={false} onToggleArchived={onToggle} onClose={vi.fn()} />,
  );
  const toggle = screen.getByRole("switch", { name: "Show archived" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(onToggle).toHaveBeenCalledWith(true);

  rerender(<SettingsDialog showArchived onToggleArchived={onToggle} onClose={vi.fn()} />);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
});
