import { useState } from "react";
import { SunIcon, MoonIcon } from "@heroicons/react/24/outline";
import { currentTheme, setTheme, type Theme } from "./theme";
import { Button } from "./Button";

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };
  return (
    <Button
      variant="ghost"
      onClick={toggle}
      aria-label="toggle theme"
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      icon={theme === "dark" ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
    />
  );
}
