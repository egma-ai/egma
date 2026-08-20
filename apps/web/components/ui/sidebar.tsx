"use client";

import { Slot } from "radix-ui";
import {
  createContext,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * The signed-in navigation bar, as parts.
 *
 * These are shadcn's Sidebar primitives with egma's theme on them and the parts
 * this product has no use for left out. What is missing is missing on purpose:
 *
 * - **No collapsible rail, no icon mode, no persisted open state.** egma's bar
 *   is always open on a wide screen and always a drawer on a narrow one, and
 *   the shell already owns that switch at its one layout breakpoint. A second
 *   opinion about when a sidebar is open would be a second navigation model.
 * - **No `Sidebar` root.** The `<aside>` is the shell's own frame — it is a
 *   column of the shell's grid and it is what the breakpoint hides — so it
 *   stays where the shell keeps it. These primitives own everything inside it.
 * - **No mobile `Sheet`.** The drawer is the product's existing one, and the
 *   same three groups are drawn inside it rather than a second copy of them.
 *
 * Every value here is a theme key and every theme key reads one of egma's own
 * declarations in `tailwind-theme.css`, so nothing in this file holds a colour,
 * a size or a duration of its own.
 */

type SidebarContextValue = {
  /**
   * What to do after a person has chosen somewhere to go.
   *
   * The drawer copy of the bar has to close itself, and the docked copy has
   * nothing to do. It is context rather than a prop because it belongs to the
   * bar rather than to a row: a row that had to be told would be a row that can
   * be forgotten, and the one that is forgotten leaves a drawer standing over
   * the page it just opened.
   */
  readonly onNavigate?: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (value === null) {
    throw new Error("useSidebar has to be used inside a SidebarProvider.");
  }
  return value;
}

function SidebarProvider({
  onNavigate,
  children,
}: {
  readonly onNavigate?: () => void;
  readonly children: ReactNode;
}) {
  const value = useMemo<SidebarContextValue>(() => ({ onNavigate }), [onNavigate]);

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

/**
 * The topmost slot, which holds the organization and project switcher.
 *
 * `min-w-0` is the load-bearing part: the switcher names an organization and a
 * project, and a long name in a 224px column has to be allowed to shrink rather
 * than push the bar wider than the grid column it is in.
 */
function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  );
}

/**
 * The groups, and the one thing in the bar that scrolls.
 *
 * `min-h-0` is what lets it scroll rather than push the footer off a short
 * screen: a flex child will not shrink below its content without it, and the
 * account control would be the part that left.
 *
 * `asChild` is here because this is the product's navigation landmark. The
 * caller supplies the `<nav>` and its label; this supplies the layout.
 */
function SidebarContent({
  className,
  asChild = false,
  ...props
}: ComponentProps<"div"> & { readonly asChild?: boolean }) {
  const Component = asChild ? Slot.Root : "div";

  return (
    <Component
      data-slot="sidebar-content"
      className={cn(
        "flex w-full min-w-0 min-h-0 flex-col gap-6 overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

/** The bottom slot, which holds the account control. */
function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("mt-auto flex w-full min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

/**
 * A labelled set of rows.
 *
 * The label is tied to the group rather than left floating above it, so a
 * screen reader says which group it has entered instead of reading six links
 * with nothing between them. The id is made here and taken by the label,
 * because a group knows it has one and a caller should not have to invent a
 * unique string for every bar it draws.
 */
const SidebarGroupLabelId = createContext<string | null>(null);

function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  const labelId = useId();

  return (
    <SidebarGroupLabelId.Provider value={labelId}>
      <div
        data-slot="sidebar-group"
        role="group"
        aria-labelledby={labelId}
        className={cn("flex w-full min-w-0 flex-col gap-1", className)}
        {...props}
      />
    </SidebarGroupLabelId.Provider>
  );
}

/**
 * The word over a group.
 *
 * **It is a heading, because a sectioned navigation is walked by heading.** The
 * `aria-labelledby` wiring above already gives the group its accessible name;
 * this is the other half, and they answer different questions. The name is what
 * a person hears once they are *inside* a group. A heading is how they get to
 * one at all — the heading list is Global, Simulations, Monitoring, and jumping
 * between them is one keystroke rather than six arrow presses.
 *
 * `h2` because the bar has no heading above it and the page's own title is the
 * `h1` beside it. It carries no size of its own — `DESIGN.md` removed those —
 * so `text-sm` is the size, and `globals.css` holds every heading at weight
 * 400. `mt-0` is not decoration: `globals.css` gives headings the browser's own
 * margins back for the legacy pages, and a heading here must not inherit them.
 *
 * Weight 400 and the compact label treatment, which is what the bar already
 * used for the one group label it had. It is quiet on purpose: the label says
 * where a row belongs, and the row is the thing being read. `px-3` is the row's
 * own padding, so the label starts exactly where the row's content starts.
 */
function SidebarGroupLabel({ className, ...props }: ComponentProps<"h2">) {
  const labelId = useContext(SidebarGroupLabelId);

  return (
    <h2
      data-slot="sidebar-group-label"
      id={labelId ?? undefined}
      className={cn(
        "mt-0 mb-1 px-3 text-sm text-faint tracking-(--tracking-label) uppercase",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn(
        "m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("relative", className)}
      {...props}
    />
  );
}

/**
 * One row of the bar.
 *
 * **The active row wears Ember Wash and a small Ember mark**, which is what
 * `DESIGN.md` asks of a current item, and it says `aria-current="page"` as
 * well — state is never colour alone. The mark is drawn on every row and
 * coloured on the active one, so the row's text sits in the same place whether
 * or not it is the one you are on.
 *
 * **The motion is colour and nothing else.** A sidebar row is the most-pressed
 * control in the product and `DESIGN.md` is exact about that: do not animate
 * actions used many times each day, and give routine navigation colour
 * feedback. So there is no press scale here — the row answers on press rather
 * than after a movement — and the 140ms hover is the theme's hover token,
 * dropped entirely under reduced motion the way the rest of the bar's
 * ancestors already drop theirs.
 *
 * **The two properties are named rather than reached for as `transition-colors`,
 * and a keyboard pass is what found the difference.** Tailwind's `colors` group
 * sweeps in `outline-color`, and this product's focus indicator is an outline —
 * so every Tab step through the bar faded its ring up from the row's text
 * colour over 140ms. That is animating keyboard navigation, which `DESIGN.md`
 * names first among the things not to animate, and it is a focus indicator
 * arriving late, which is worse. Hover changes the background and the text and
 * nothing else, so those two are what move.
 *
 * The row is 44px tall in every theme and at every width, so a coarse pointer
 * needs no separate rule to reach it.
 */
function SidebarMenuButton({
  className,
  isActive = false,
  asChild = false,
  onClick,
  ...props
}: ComponentProps<"button"> & {
  readonly isActive?: boolean;
  readonly asChild?: boolean;
}) {
  const { onNavigate } = useSidebar();
  const Component = asChild ? Slot.Root : "button";

  return (
    <Component
      data-slot="sidebar-menu-button"
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative flex w-full min-w-0 items-center gap-3",
        "min-h-(--control-lg) rounded-button px-3",
        "text-base text-muted-foreground no-underline",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "motion-reduce:transition-none",
        "before:absolute before:inset-y-3 before:left-0 before:w-0.5",
        "before:rounded-chip before:bg-transparent before:content-['']",
        "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
        "data-[active=true]:bg-selected data-[active=true]:text-foreground",
        "data-[active=true]:before:bg-brand",
        "data-[active=true]:[&_svg]:text-brand",
        className,
      )}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        onNavigate?.();
      }}
      {...props}
    />
  );
}

export {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
};
