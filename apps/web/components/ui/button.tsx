import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { useId, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Map registry-compatible variants to Egma's primary, outlined, quiet, and
 * destructive styles. Default size fits toolbars; lg fits forms. Coarse
 * pointers retain the minimum tap target through shared theme values.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap",
    "rounded-button text-sm font-medium no-underline",
    /* "Pointer targets are at least 44px on coarse pointers." */
    "pointer-coarse:min-h-(--tap-target)",
    // Named properties, never `all`, and never `outline-color`. Tailwind's
    // `transition-colors` includes it, which fades the focus ring in over
    // 140ms on every Tab step — motion on keyboard navigation, which
    // `DESIGN.md` forbids outright.
    "transition-[color,background-color,border-color] duration-(--duration-hover) ease-out",
    /*
     * **A control that cannot be pressed does not answer a pointer.** Every
     * variant's hover state is behind `not-disabled:`, because the wash
     * primary's was not: a disabled Save repainted as an available one the
     * moment somebody's pointer rested on it, which is the opposite of what a
     * disabled control is for. `active:` needs no guard — a browser does not
     * fire it on a disabled element.
     */
    "disabled:cursor-not-allowed disabled:opacity-55",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        /*
         * Primary: Ember Wash behind Deep Ember, on the ordinary neutral
         * hairline — the button the boards draw. The border stays `--border`
         * through every state: what answers a press is the fill and the ink,
         * and a hairline that moved as well would make the control look like
         * it changed size.
         */
        default: [
          "border border-border bg-primary-wash text-primary",
          "pointer-hover:not-disabled:bg-primary-wash-hover",
          "pointer-hover:not-disabled:text-primary-hover",
          "active:bg-primary-wash-pressed active:text-primary-pressed",
        ],
        /*
         * Raise the secondary border on hover as well as its fill. Border and
         * foreground tokens differ in dark mode.
         */
        secondary: [
          "border border-border-strong bg-transparent text-foreground",
          "pointer-hover:not-disabled:border-foreground",
          "pointer-hover:not-disabled:bg-surface-soft",
        ],
        outline: [
          "border border-border-strong bg-transparent text-foreground",
          "pointer-hover:not-disabled:border-foreground",
          "pointer-hover:not-disabled:bg-surface-soft",
        ],
        /* Quiet action: text only. */
        ghost: [
          "border border-transparent bg-transparent text-foreground",
          "pointer-hover:not-disabled:bg-surface-soft",
        ],
        link: [
          "border border-transparent bg-transparent text-foreground underline-offset-4",
          "pointer-hover:not-disabled:underline",
        ],
        /* Destructive: the failure colour, and never the brand colour. */
        destructive: [
          "border border-destructive bg-destructive text-destructive-foreground",
          "pointer-hover:not-disabled:bg-destructive-hover",
          "pointer-hover:not-disabled:border-destructive-hover",
          "active:bg-destructive-pressed active:border-destructive-pressed",
        ],
      },
      size: {
        /* 36px and 16px of side padding: the toolbar control the boards draw. */
        default: "min-h-(--control-md) px-4",
        /* Denser still, for a control inside a row rather than above a list. */
        sm: "min-h-(--control-sm) px-3",
        /* 44px: the form control, which is what a sheet or a dialog footer holds. */
        lg: "min-h-(--control-lg) px-5",
        /* A square, sized to the toolbar control it stands beside. */
        icon: "min-h-(--control-md) w-(--control-md) px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * Show disabled-action reasons beside the control and associate them with
 * aria-describedby. A title alone is not accessible to keyboard users.
 */
function WhyNot({ id, why }: { readonly id: string; readonly why: string }) {
  return (
    <span className="max-w-[56ch] text-sm text-muted-foreground" id={id}>
      {why}
    </span>
  );
}

/**
 * busy keeps an in-flight action inert and announced; why disables it with
 * a visible explanation. Neither replaces server authorization.
 * No type default is set, so callers must specify button versus submit in forms.
 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  busy = false,
  disabled,
  why,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    readonly asChild?: boolean;
    /** A write is in flight. It remains visible, named, and inert until it settles. */
    readonly busy?: boolean;
    /**
     * Why it is not available. Shown beside the control and named by it, so it
     * reaches a keyboard and a screen reader and not only a pointer.
     */
    readonly why?: string;
  }) {
  const said = useId();
  const Component = asChild ? Slot.Root : "button";
  const inert = disabled === true || busy;
  const explained = inert && why !== undefined;

  const button = (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={inert || undefined}
      aria-busy={busy ? "true" : undefined}
      title={why}
      aria-describedby={explained ? said : undefined}
      {...props}
    />
  );

  if (!explained) return button;

  return (
    <>
      {button}
      <WhyNot id={said} why={why} />
    </>
  );
}

export { Button, buttonVariants };
