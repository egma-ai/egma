import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { useId, type ComponentProps } from "react";

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
    // Named properties, never `all`, and never `outline-color`. Tailwind's
    // `transition-colors` includes it, which fades the focus ring in over
    // 140ms on every Tab step — motion on keyboard navigation, which
    // `DESIGN.md` forbids outright.
    "transition-[color,background-color,border-color] duration-(--duration-hover) ease-out",
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
        /*
         * Secondary: transparent with a one-pixel Midnight Ink border.
         *
         * Hover raises the border to `--foreground` as well as the fill. In
         * light theme that is invisible — `--border-strong` and `--foreground`
         * are both Midnight Ink — which is exactly why it went missing: the
         * CSS Modules button it replaces said it out loud, and dark theme is
         * where the two part company (`#4a4a44` against `#f2f2ed`). Without
         * it a quiet button in dark theme answered a hover with a fill change
         * and a border that stayed put.
         */
        secondary: [
          "border border-border-strong bg-transparent text-foreground",
          "pointer-hover:border-foreground pointer-hover:bg-surface-soft",
        ],
        outline: [
          "border border-border-strong bg-transparent text-foreground",
          "pointer-hover:border-foreground pointer-hover:bg-surface-soft",
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

/**
 * Why a control is not available, said where anybody can find it.
 *
 * **A disabled button cannot take focus, so a tooltip on one is a reason only
 * a mouse can reach.** The developer's decision was to *disable rather than
 * hide* precisely so a viewer is told why an action is not theirs — and a
 * reason half the people using egma cannot get to does not deliver that
 * decision, it only looks like it does.
 *
 * So the sentence is written on the page beside the control, and the control
 * points at it with `aria-describedby`. It stays a `title` as well, because a
 * pointer user hovering is a real way to ask.
 */
function WhyNot({ id, why }: { readonly id: string; readonly why: string }) {
  return (
    <span className="max-w-[56ch] text-sm text-muted-foreground" id={id}>
      {why}
    </span>
  );
}

/**
 * The button, and the two things this product's buttons have always carried
 * that the registry's does not.
 *
 * `busy` and `why` are **optional and default to what a stock shadcn button
 * does**, so every existing caller compiles and draws unchanged. They are here
 * rather than at each call site because both are product decisions written down
 * in `DESIGN.md` and in the permission model, and both are the kind of decision
 * that is quietly lost when it is copied to forty places:
 *
 * - **`busy`** is a write in flight. The control stays visible, named, and
 *   inert until it settles, and says so to assistive technology rather than
 *   only to the eye.
 * - **`why`** is why an action is not this person's. It disables the control
 *   *and* writes the sentence beside it, because a disabled button cannot take
 *   focus and a `title` alone is a reason only a pointer can reach.
 *
 * Neither is authorization. The server checks the same permission on every
 * request and refuses a viewer's write whether or not a browser was involved.
 *
 * **`type` is deliberately not defaulted**, which is the registry's behaviour
 * and not this product's old one. A `<button>` inside a `<form>` submits it
 * unless it says otherwise, so every caller says which it is. The CSS Modules
 * button defaulted to `type="button"`; a migration that leans on that default
 * instead of saying the word turns a Remove control into a form submission.
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
