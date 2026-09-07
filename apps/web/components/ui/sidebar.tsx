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
 * Sidebar content primitives; the shell owns its aside, wide/narrow breakpoint,
 * and mobile drawer. Do not introduce separate persisted or collapsible state here.
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
 * Organization header sharing height and divider tokens with the adjacent
 * top bar. Project selection is rendered separately below it.
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
 * Let navigation scroll without pushing the account footer offscreen.
 * Callers may supply the labeled nav landmark through asChild.
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
 * Associate labeled groups with generated heading IDs. An unlabeled group
 * must omit both group semantics and aria-labelledby to avoid a dangling name.
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
 * Use h2 for navigation group headings so users can jump between sections.
 * Keep compact type and align labels with navigation icons.
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
 * Mark the current page visually and with aria-current without shifting text.
 * Use color-only navigation feedback and explicit transition properties so
 * focus outlines do not animate. Preserve coarse-pointer target sizes.
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
        "pointer-hover:data-[active=false]:bg-surface-soft pointer-hover:data-[active=false]:text-foreground",
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
