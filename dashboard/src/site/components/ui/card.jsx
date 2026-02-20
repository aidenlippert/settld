import * as React from "react";

import { cn } from "../../../lib/utils.js";

const Card = React.forwardRef(({ className, as: Comp = "div", ...props }, ref) => (
  <Comp
    ref={ref}
    className={cn(
      "rounded-2xl border border-[#d8d0c1] bg-[rgba(255,253,248,0.92)] text-[#1b2430] shadow-[0_8px_24px_rgba(60,44,21,0.08)]",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex flex-col space-y-2 p-5 sm:p-6 lg:p-7", className)} {...props} />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef(({ className, ...props }, ref) => (
  <h3 ref={ref} className={cn("text-2xl font-bold tracking-[-0.01em]", className)} {...props} />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-[#354152]", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("px-5 pb-5 pt-0 sm:px-6 sm:pb-6 lg:px-7 lg:pb-7", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex items-center px-5 pb-5 pt-0 sm:px-6 sm:pb-6 lg:px-7 lg:pb-7", className)} {...props} />
));
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
