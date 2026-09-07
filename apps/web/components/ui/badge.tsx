import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Use semantic tones for status badges and let text carry the meaning.
 * Brand color is not a result state; callers supply supporting icons when needed.
 */
const badgeVariants = cva(
  [
    "inline-flex w-fit shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "rounded-chip border text-sm",
    "[&>svg]:pointer-events-none [&>svg]:size-3",
  ],
  {
    variants: {
      variant: {
        neutral: "border-border text-muted-foreground",
        success: "border-success-border text-success",
        warning: "border-warning-border text-warning",
        failure: "border-failure-border text-failure",
      },
      /*
       * Keep shape separate from tone: verdict uses a compact uppercase label,
       * while count preserves ordinary text for numbers and identifiers.
       */
      shape: {
        verdict: "min-h-(--control-sm) px-3 tracking-(--tracking-label) uppercase",
        count: "h-(--chip-height) min-w-7 bg-surface-soft px-2",
      },
    },
    defaultVariants: {
      variant: "neutral",
      shape: "verdict",
    },
  },
);

function Badge({
  className,
  variant,
  shape,
  asChild = false,
  ...props
}: ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    readonly asChild?: boolean;
  }) {
  const Component = asChild ? Slot.Root : "span";

  return (
    <Component
      data-slot="badge"
      className={cn(badgeVariants({ variant, shape }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
