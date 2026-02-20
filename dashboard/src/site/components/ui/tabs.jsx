import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "../../../lib/utils.js";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex w-full flex-wrap items-center gap-1 rounded-xl border border-[#d8d0c1] bg-[rgba(255,253,248,0.72)] p-1 text-[#354152]",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex min-w-[110px] flex-1 items-center justify-center whitespace-nowrap rounded-lg px-2 py-2 text-xs font-semibold transition-all sm:px-3 sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a3472f]/40 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[#1f1f1f] data-[state=active]:text-[#f7f2ea] data-[state=active]:shadow",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a3472f]/40", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
