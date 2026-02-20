import * as React from "react";

import { cn } from "../../../lib/utils.js";

function Badge({ className, variant = "default", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em]",
        variant === "default" && "border-[#d8d0c1] bg-[#fffdf8] text-[#1b2430]",
        variant === "accent" && "border-[#b9a98e] bg-[#efe8da] text-[#7f2f1f]",
        className
      )}
      {...props}
    />
  );
}

export { Badge };
