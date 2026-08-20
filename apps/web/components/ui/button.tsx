import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The three kinds of button `DESIGN.md` names, plus the destructive one.
 *
 * The variant names are shadcn's, so a component pasted from the registry
 * arrives already dressed. What each name *draws* is egma's: `default` is the
 * Deep Ember primary, `secondary` and `outline` are both the one outlined kind
 * `DESIGN.md` describes, and `ghost` and `link` are both the quiet action.
 * shadcn's own `secondary` — a filled grey button — is a look this product does
 * not have, so no name produces it.
 *
 * **When migrating:** the CSS Modules `Button` defaults to the outlined kind and
 * takes `weight="strong"` for the filled one. This one defaults to the filled
 * one, because that is what `variant="default"` means everywhere shadcn is
 * used. A migrated quiet button therefore has to say `variant="secondary"` out
 * loud; a migration that drops the prop turns a quiet button primary.
 *
 * Every value here is a theme key, and every theme key is a `tokens.css`
 * declaration. The result is the same 44px, 6px-radius, weight-500 button the
 * CSS Modules `Button` already draws — which is the point while both exist.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap",
    "rounded-button text-sm font-medium no-underline",
    // Named properties, never `all`.
    "transition-colors duration-(--duration-hover) ease-out",
    "disabled:cursor-not-allowed disabled:opacity-55",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        /* Primary: Deep Ember fill, white text. */
        default: [
          "border border-primary bg-primary text-primary-foreground",
          "pointer-hover:bg-primary-hover pointer-hover:border-primary-hover",
          "active:bg-primary-pressed active:border-primary-pressed",
        ],
        /* Secondary: transparent with a one-pixel Midnight Ink border. */
        secondary: [
          "border border-border-strong bg-transparent text-foreground",
          "pointer-hover:bg-surface-soft",
        ],
        outline: [
          "border border-border-strong bg-transparent text-foreground",
          "pointer-hover:bg-surface-soft",
        ],
        /* Quiet action: text only. */
        ghost:
          "border border-transparent bg-transparent text-foreground pointer-hover:bg-surface-soft",
        link: "border border-transparent bg-transparent text-foreground underline-offset-4 pointer-hover:underline",
        /* Destructive: the failure colour, and never the brand colour. */
        destructive: [
          "border border-destructive bg-destructive text-destructive-foreground",
          "pointer-hover:bg-destructive-hover pointer-hover:border-destructive-hover",
          "active:bg-destructive-pressed active:border-destructive-pressed",
        ],
      },
      size: {
        /* 44px, which is also the coarse-pointer target `DESIGN.md` asks for. */
        default: "min-h-(--control-lg) px-4",
        /* Dense toolbars, where the row is the target rather than the control. */
        sm: "min-h-(--control-sm) px-3",
        lg: "min-h-(--control-lg) px-5",
        icon: "min-h-(--control-lg) w-(--control-lg) px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    readonly asChild?: boolean;
  }) {
  const Component = asChild ? Slot.Root : "button";

  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
