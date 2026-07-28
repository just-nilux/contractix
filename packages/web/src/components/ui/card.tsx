import { type PropsWithChildren } from "react";

import { cn } from "../../lib/cn.js";

export function Card({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={cn("rounded-lg border border-slate-200 bg-white p-6", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children }: PropsWithChildren) {
  return <h2 className="text-base font-semibold text-slate-900">{children}</h2>;
}
