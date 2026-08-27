"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Switching between peer views of one page.
 *
 * **Radix is here for the keyboard, not for the look.** The tabs pattern is a
 * roving tab stop — one Tab step into the group, then Left, Right, Home and
 * End inside it — and a hand-written version of that is a listener per strip
 * that each has to get `dir`, looping, and the disabled tab right on its own.
 * Radix publishes it once, and it publishes `data-state` and `data-orientation`
 * alongside, which is what every rule below reads.
 *
 * `DESIGN.md` calls a tab strip navigation: "Navigation row — support routine
 * navigation — colour feedback only." So nothing here moves. The current tab
 * uses a fixed 2px Ember edge and medium label weight. A segmented control
 * keeps the approved top edge. A page or panel rail meets the content below it,
 * so its edge sits at the bottom. The weight is reserved in the compact strip
 * and changes no box dimensions.
 */
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The two shapes a strip of tabs takes in this product.
 *
 * - `default` is the segmented control: a quiet track holding the choices, and
 *   the current one on the plain product surface. It is for a small closed
 *   set that belongs inside a row of other controls.
 * - `line` is the rail: the choices sit on a hairline and the current one is
 *   marked on it — the mark alone, with no fill behind the label. It is for the
 *   top of a page or a panel, where the strip is what a whole region is
 *   switched by.
 *
 * The track and choices use the product's square geometry. Four pixels of
 * padding keep the segmented control readable as one unit.
 */
const tabsListVariants = cva(
  [
    "group/tabs-list inline-flex w-fit items-center gap-1",
    "group-data-[orientation=vertical]/tabs:flex-col",
    "group-data-[orientation=vertical]/tabs:items-stretch",
  ],
  {
    variants: {
      variant: {
        default: "justify-center rounded-input bg-surface-soft p-1",
        line: "justify-start bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

/**
 * One choice in the strip.
 *
 * The current one always carries a mark that survives a greyscale screenshot:
 * a 2px rule at the content-facing edge. `DESIGN.md`: "State is not
 * communicated by colour alone." The active fill stays plain so the mark and
 * label do the work.
 *
 * There is no `focus-visible` rule here on purpose. `globals.css` draws the
 * product's Ember focus ring for everything a keyboard reaches, `[role="tab"]`
 * named among them, from an unlayered rule that no utility can undo. A ring
 * written here would be a second answer to a question already settled.
 */
function TabsTrigger({
  className,
  onClick,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        [
          "relative inline-flex flex-1 cursor-pointer items-center justify-center gap-2",
          /*
           * Down a rail the labels start together. The list stretches its tabs
           * to the widest one, so centring leaves every shorter label sitting
           * at its own indent and the column reads ragged.
           */
          "group-data-[orientation=vertical]/tabs:justify-start",
          "min-h-(--control-sm) rounded-button border border-transparent px-3",
          "text-sm whitespace-nowrap text-muted-foreground",
          "pointer-coarse:min-h-(--tap-target)",
          /*
           * Named properties, never `all`, and never `outline-color`: see
           * `button.tsx`. A transition that includes the outline fades the
           * focus ring in on every arrow-key step through the strip.
           */
          "transition-[color,background-color,border-color] duration-(--duration-hover) ease-out",
          /*
           * **Hover is for the tabs somebody might go to, not the one they are
           * on.** The neutral hover and active surface are both backgrounds,
           * and an unscoped hover wins: pointing at the current tab turned its
           * surface grey and took the "current" half of the state with it. Found in a
           * browser, because the two rules never meet until a pointer is on
           * one. Scoping to `inactive` makes them mutually exclusive, so which
           * of them Tailwind happens to emit first stops mattering.
           */
          "pointer-hover:data-[state=inactive]:bg-surface-soft",
          "pointer-hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-55",
          /*
           * The current tab's label darkens in both shapes. The *fill* does
           * not: see the two variant blocks below.
           */
          "data-[state=active]:text-foreground",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0",
          "[&_svg:not([class*='size-'])]:size-4",
        ],
        [
          /* The segmented choice stays on the plain product surface. */
          "group-data-[variant=default]/tabs-list:data-[state=active]:bg-surface",
          "group-data-[variant=default]/tabs-list:data-[state=active]:font-medium",
        ],
        [
          /*
           * The rail tab: sized to its own label, sitting on the hairline
           * rather than in a track, and squared off where it meets it.
           */
          "group-data-[variant=line]/tabs-list:flex-none",
          "group-data-[variant=line]/tabs-list:min-h-(--control-lg)",
          /*
           * No border on a rail tab. The shared one is transparent and exists
           * only to hold the room the segmented plate's Ember edge moves into,
           * so on this variant it is a pixel that draws nothing — and it is the
           * pixel between the first label and the column edge below.
           */
          "group-data-[variant=line]/tabs-list:border-0",
          /*
           * **The first label starts on the column's own left edge.** A rail
           * strip leads a page, so its first word is read against the headings
           * under it — and the shared `px-3` that gives every tab its plate had
           * pushed that word 12px right of every `Section` title beside it.
           * `DESIGN.md` asks for exact alignment.
           *
           * Padding rather than a negative margin on the list, which is the
           * other way to do this: the Settings column is `overflow-y-auto`, so
           * its `overflow-x` computes to `auto` as well, and anything pulled
           * left of the content box is clipped with no scroll that can reach
           * it. Dropping the first tab's own left padding moves the label and
           * its plate together, and neither leaves the column.
           *
           * Horizontal only. Down a vertical rail the first tab is the top
           * one, and taking its left padding away would step it out of line
           * with every tab below it.
           */
          "group-data-[orientation=horizontal]/tabs:group-data-[variant=line]/tabs-list:first:pl-0",
          /*
           * The mark, drawn for the current tab and colourless for the rest.
           *
           * **The colour is the switch, and `content` cannot be.** Tailwind 4
           * writes `content: var(--tw-content)` into *every* `after:` utility
           * and declares `--tw-content` with an initial value of `""`, so the
           * pseudo-element already exists the moment any `after:` class is on
           * the element. Gating `content-['']` on the active state therefore
           * turns nothing on or off — it was written that way first, and every
           * tab in the strip drew a rule. The sidebar's active mark in
           * `shell.tsx` had already settled this the other way round.
           *
           * The bar appears rather than fades: a transition on the trigger
           * does not reach its own pseudo-element, and none is declared here.
           * That is what `DESIGN.md` wants of a strip crossed by arrow key many
           * times a day.
           *
           * One pixel of overhang keeps the 2px mark crisp against the edge.
           * A segmented choice keeps the approved top mark. A rail tab marks
           * the bottom edge where it meets the panel it switches.
           */
          "after:absolute after:rounded-chip after:bg-transparent",
          "data-[state=active]:after:bg-brand",
          "group-data-[orientation=horizontal]/tabs:after:inset-x-0",
          "group-data-[orientation=horizontal]/tabs:group-data-[variant=default]/tabs-list:after:-top-px",
          "group-data-[orientation=horizontal]/tabs:group-data-[variant=line]/tabs-list:after:-bottom-px",
          "group-data-[orientation=horizontal]/tabs:after:h-0.5",
          "group-data-[orientation=vertical]/tabs:after:inset-y-0",
          "group-data-[orientation=vertical]/tabs:after:-right-px",
          "group-data-[orientation=vertical]/tabs:after:w-0.5",
        ],
        className,
      )}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        /*
         * **A tab answers a press, so a click with no press behind it has to
         * be given one.**
         *
         * Radix selects on `mousedown` rather than on `click`, which is right
         * — `DESIGN.md`: "A control answers on press, not after an animation."
         * A pointer press reaches it through `mousedown` and a keyboard Enter
         * through `keydown`, so both are already answered.
         *
         * What reaches neither is a click that was *dispatched* rather than
         * performed — a script, an automation harness, or this repository's
         * own component tests, where `fireEvent.click` sends the click alone
         * and no press ever happens. Eight Settings tests failed on exactly
         * that. So the press is re-issued rather than the selection being
         * re-implemented here, and Radix stays the one thing that decides what
         * activating a tab means.
         *
         * **`isTrusted` is what keeps this off the keyboard path.** A browser
         * fires a click with `detail === 0` after Enter or Space as well, so
         * `detail` alone cannot tell a dispatched click from a keyboard one —
         * and re-issuing there hands the consumer a second `onValueChange` for
         * one press. Harmless against a page that commits the change straight
         * away, and a trap for one that does not. Only a browser can set
         * `isTrusted`, so a dispatched click is the one case left.
         *
         * **The re-issued press bubbles**, because React listens at the root
         * and would not see it otherwise. It can therefore also reach an
         * ancestor's `onMouseDown` or an outside-press handler. Nothing wraps a
         * tab strip that way today; a component that does needs to know this is
         * here.
         */
        if (event.defaultPrevented || event.detail > 0) return;
        if (event.nativeEvent.isTrusted) return;
        event.currentTarget.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, button: 0 }),
        );
      }}
    />
  );
}

/** The panel one tab reveals. Radix labels it by its trigger and hides the rest. */
function TabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
