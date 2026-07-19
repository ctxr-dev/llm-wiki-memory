import { useState } from "react";
import { currentTheme, setTheme, type Theme } from "./theme";

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };
  return (
    <button
      onClick={toggle}
      className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
      aria-label="toggle theme"
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
