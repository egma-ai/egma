"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Use Radix for tab focus, selection, and orientation. Keep routine navigation
 * free of spatial motion; mark the active tab with an edge and label treatment.
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
 * default is a segmented control; line is a rail at a page or panel edge.
 * Both retain the same tab behavior with theme-defined geometry.
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
 * Use a persistent edge mark as well as color for active state. Shared focus
 * styles provide the keyboard indicator.
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
           * Remove first-tab leading padding on horizontal rails to align with content.
           * A negative list margin could be clipped by the settings scroll container.
           * Keep vertical-rail labels aligned with each other.
           */
          "group-data-[orientation=horizontal]/tabs:group-data-[variant=line]/tabs-list:first:pl-0",
          /*
           * Keep the pseudo-element present and switch its color by active state.
           * Tailwind pseudo-element utilities may create it even without an active-only
           * content rule. The marker changes immediately during keyboard navigation.
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
         * Synthetic clicks may omit the mousedown that Radix uses for selection.
         * Forward only untrusted clicks through a bubbling mousedown; real pointer
         * and keyboard activation already have their own paths. The forwarded event
         * can also reach ancestor handlers.
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
