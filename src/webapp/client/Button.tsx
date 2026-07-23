import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "row";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
};

const BASE =
  "inline-flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "rounded bg-slate-800 px-3 py-1 text-sm text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-slate-300",
  secondary:
    "rounded border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600",
  ghost:
    "rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200",
  danger:
    "rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700",
  row: "",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", icon, children, className, type, ...rest },
  ref,
) {
  const classes = [BASE, VARIANTS[variant], className].filter(Boolean).join(" ");
  return (
    <button ref={ref} type={type ?? "button"} className={classes} {...rest}>
      {icon ? (
        <span className="inline-flex shrink-0" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
});
