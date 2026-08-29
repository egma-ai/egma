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
 * The organization bar at the very top of the signed-in sidebar.
 *
 * The approved Paper refinement puts the Egma mark, organization name, plan
 * and arrows in this row. The project is a separate control below it.
 *
 * 56px tall over a hairline, which is exactly the topbar beside it (`73A-0`
 * and `71V-0` are both 56). The two bars line up across the whole application
 * because they read the same two theme values, not because somebody matched
 * them once.
 */
function SidebarBrand({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-brand"
      className={cn(
        "flex h-(--sidebar-header-height) w-full min-w-0 flex-none items-center",
        "border-b border-border px-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The slot under the organization bar, which holds the project switcher.
 *
 * `min-w-0` is the load-bearing part: a long project name in a 224px column has
 * to shrink rather than push the bar wider than the grid column it is in.
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
 * A set of rows, labelled or not.
 *
 * The label is tied to the group rather than left floating above it, so a
 * screen reader says which group it has entered instead of reading six links
 * with nothing between them. The id is made here and taken by the label,
 * because a group knows it has one and a caller should not have to invent a
 * unique string for every bar it draws.
 *
 * **`labelled={false}` is for the group that is drawn without a heading**, and
 * it takes the region away with the heading rather than only hiding the word.
 * A `role="group"` still pointing `aria-labelledby` at a heading that is not
 * rendered is a named region with a dangling name — a screen reader announces a
 * group and then has nothing to call it. So an unlabelled group is a plain
 * wrapper: the rows inside it are still links in the same `<nav>`, and they are
 * reached exactly as they were. It defaults to `true`, so every group that had
 * a heading before this prop existed keeps the heading and the region it had.
 */
const SidebarGroupLabelId = createContext<string | null>(null);

function SidebarGroup({
  className,
  labelled = true,
  ...props
}: ComponentProps<"div"> & { readonly labelled?: boolean }) {
  const labelId = useId();

  return (
    <SidebarGroupLabelId.Provider value={labelled ? labelId : null}>
      <div
        data-slot="sidebar-group"
        {...(labelled ? { role: "group", "aria-labelledby": labelId } : {})}
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
 * one at all — the heading list is Simulations and Monitoring, and jumping
 * between them is one keystroke rather than six arrow presses. The top group
 * is not in that list, because it is drawn with no heading at all: it is the
 * two rows a person lands on, reached before any jump is needed.
 *
 * `h2` because the bar has no heading above it and the page's own title is the
 * `h1` beside it. It carries no size of its own — `DESIGN.md` removed those —
 * so `text-sm` is the size, and `globals.css` holds every heading at weight
 * 400. `mt-0` is not decoration: `globals.css` gives headings the browser's own
 * margins back for the legacy pages, and a heading here must not inherit them.
 *
 * Weight 400 and the compact label treatment, which is what the bar already
 * used for the one group label it had. It is quiet on purpose: the label says
 * where a row belongs, and the row is the thing being read. `px-2` is the row's
 * own padding, so the label starts exactly where the row's icon starts — on the
 * bar's 16px gutter, in line with the project block above it.
 */
function SidebarGroupLabel({ className, ...props }: ComponentProps<"h2">) {
  const labelId = useContext(SidebarGroupLabelId);

  return (
    <h2
      data-slot="sidebar-group-label"
      id={labelId ?? undefined}
      className={cn(
        /*
         * `my-0`: the group's own 4px gap is the space under the label, and a
         * margin of the label's as well made it 8. The boards put the label
         * one gap above its first row like every other pair in the column.
         */
        "my-0 px-2 text-sm text-faint tracking-(--tracking-label) uppercase",
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
 * **The row is 36px where the pointer is fine and 44px where it is coarse.** A
 * bar of six rows is read as a block rather than pressed one row at a time, and
 * at 44px each the block was loose enough to read as six boxes stacked instead
 * of two or three clusters. 36px is `--control-md`, the height this product
 * already gives a compact control. The 44px tap target is not traded away for
 * that: `pointer-coarse` puts it straight back on every touch screen, which is
 * the same rule the segmented choice control already uses.
 *
 * **The row's 8px padding is what puts its icon on the bar's 16px gutter.** The
 * column around it is inset 8, so 8 and 8 land the icon exactly where the Egma
 * mark, the word `Project`, the project name and the group labels already
 * start: one left edge down the whole sidebar. It was 12 against a column inset
 * of 16, which put every icon and every group label 12px right of the project
 * block above them. The Ember mark is unaffected either way — it is absolutely
 * placed on the row's own leading edge and pushes nothing, so a lit row's icon
 * stands on the same line as a quiet one's.
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
        "min-h-(--control-md) rounded-button px-2",
        "pointer-coarse:min-h-(--tap-target)",
        "text-sm text-muted-foreground no-underline",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "before:absolute before:inset-y-2 before:left-0 before:w-0.5",
        "before:rounded-chip before:bg-transparent before:content-['']",
        /*
         * **The quiet hover is paper, because the row stands on the chrome.**
         * It was `--surface-soft` while the bar was paper, and the bar is
         * `--chrome` now — one value with `--surface-soft` in light theme, so
         * the plate would have been drawn in exactly the colour under it and
         * the busiest hover in the product would have gone silent. A row lifts
         * towards the work surface instead, which reads in both themes and is
         * the movement every other control on the chrome makes. `shell.tsx`
         * states the rule; the drawer wears the chrome fill so this one class
         * is true in both places the bar is drawn.
         */
        "pointer-hover:data-[active=false]:bg-surface pointer-hover:data-[active=false]:text-foreground",
        "data-[active=true]:bg-selected data-[active=true]:text-foreground",
        "data-[active=true]:before:bg-brand",
        /*
         * The icon follows the row's own colour rather than turning Ember. The
         * boards draw the lit row's symbol in ink beside ink text (`72T-0`),
         * and they are right to: the Ember mark on the left edge is already
         * the brand signal, and a second one inside the row makes the two
         * compete for the same job.
         */
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
  SidebarBrand,
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
