import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Placeholder sized by the caller, with enough neutral contrast to remain
 * visible. Theme selectors own pulse and reduced-motion behavior.
 * Avoid naming unused utilities in comments: Tailwind scans source text too.
 */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-input bg-border", className)}
      {...props}
    />
  );
}

export { Skeleton };
