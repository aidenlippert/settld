import * as React from "react";

import { cn } from "../../../lib/utils.js";

const Label = React.forwardRef(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn("text-xs font-bold uppercase tracking-[0.12em] text-[#657185]", className)}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
