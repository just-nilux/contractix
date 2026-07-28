import { type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn.js";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300",
  secondary:
    "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 disabled:text-slate-400",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  danger: "bg-severity-red text-white hover:opacity-90 disabled:bg-slate-300",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = "primary", className, ...rest }: ButtonProps) {
  return (
    <button
      // Defaulted before the spread so a caller can still pass type="submit".
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded px-4 py-2 text-sm font-medium transition",
        "focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none",
        "disabled:cursor-not-allowed",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}
