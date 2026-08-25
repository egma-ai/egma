import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The chip, square like everything else.
 *
 * The variant names are the meanings rather than shadcn's `default`,
 * `secondary` and `destructive`. A chip in this product usually carries a
 * product result — success, warning, failure — and `DESIGN.md` is exact about that
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
       * Two shapes, and the second one is a chip that holds a number.
       *
       * `verdict` is the chip this product has always drawn: a word in
       * letter-spaced capitals, at the dense control height. `count` is the
       * overflow chip the boards put at the end of a cell that ran out of room
       * (`719-0`) — "+3", 22px tall on the quiet neutral surface, in ordinary
       * sentence case because it is a number and capitals would say nothing.
       * It is deliberately not a variant of the colour axis above: a count
       * carries no verdict, and the colours there all do.
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
