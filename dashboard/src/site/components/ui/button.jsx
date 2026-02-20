import * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "../../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "bg-[#1f1f1f] text-[#f7f2ea] shadow-[0_10px_30px_rgba(0,0,0,0.25)] hover:bg-black focus-visible:ring-[#1f1f1f]",
        outline:
          "border border-[#d8d0c1] bg-white text-[#1f1f1f] hover:bg-[#f7f2ea] focus-visible:ring-[#a3472f]",
        ghost: "text-[#1f1f1f] hover:bg-[#efe8da] focus-visible:ring-[#a3472f]"
      },
      size: {
        default: "h-10 px-5",
        lg: "h-11 px-6 text-base",
        sm: "h-9 px-4"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? "span" : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";

function buttonClasses({ variant = "default", size = "default", className = "" } = {}) {
  return cn(buttonVariants({ variant, size, className }));
}

export { Button, buttonVariants, buttonClasses };
