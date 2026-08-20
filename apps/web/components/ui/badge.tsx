import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The chip, at the 9999px tag radius.
 *
 * The variant names are the meanings rather than shadcn's `default`,
 * `secondary` and `destructive`. A chip in this product usually carries a
 * verdict — passed, skipped, failed — and `DESIGN.md` is exact about that
 * being said in words with colour only supporting it. A name like `secondary`
 * would let a failed run be labelled with whatever colour happened to be
 * second, so those names are deliberately absent.
 *
 * There is no brand variant, for the same reason: "Brand orange does not mean
 * passed, failed, skipped, or errored."
 *
 * The chip carries the word; the caller supplies the icon or shape beside it
 * where the state needs one.
 */
const badgeVariants = cva(
  [
    "inline-flex w-fit shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "min-h-(--control-sm) rounded-chip border px-3",
    "text-sm tracking-(--tracking-label) uppercase",
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
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

function Badge({
  className,
  variant,
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
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
