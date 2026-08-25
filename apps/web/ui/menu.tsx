"use client";

import Link from "next/link";
import { useCallback, useRef, useState, type ReactNode } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A button that opens a small panel, and everything that has to be true of one
 * before somebody without a pointer can use it.
 *
 * The organization and project controls, account menu, and editor choosers all
 * use this behavior. Writing it once is what stops a later control being the
 * first one with the keyboard left out.
 *
 * **The panel is the kit's anchored surface.** `components/ui/popover.tsx` is
 * Radix, so it owns what a hand-written panel keeps getting wrong: it opens
 * against the trigger and stays on screen when there is no room below it,
 * Escape closes it and puts focus back on the button, a press outside or a
 * focus that leaves closes it, and the exit finishes before the panel is
 * removed. Radix also publishes the corner it grew from, which is how
 * `tailwind-theme.css` scales it from the trigger without this file saying so.
 *
 * **The list of items is still this file's, and that is the reason for
 * `Popover` rather than the kit's `DropdownMenu`.** A dropdown menu keeps its
 * own register of items: only what it was handed as an item takes the arrow
 * keys, and it reads every printable key as a jump to a matching item. Some
 * panels here hold a field to type in, which that would take the keys away
 * from, and the account menu's dark-theme switch is a `role="switch"` rather
 * than an item, which that would leave reachable by pointer alone. So the
 * items are found in the DOM by `data-menu-item` — a panel that grows a row
 * gets the arrow keys for free, whatever that row is.
 *
 * - **The arrow keys move between items**, Home and End reach the ends, and
 *   opening moves focus into the panel.
 * - An item marked `data-menu-focus-first` takes focus when the panel opens.
 *   This lets a panel with a field put the keyboard there before its rows.
 *
 * **A panel holding a text field is not a `menu`.** `role="menu"` promises a
 * list of commands, and neither ARIA nor a screen reader's menu mode expects a
 * textbox inside one. A panel that has something to type in is a `dialog`
 * holding ordinary controls; a panel that is only commands stays a `menu`.
 * That is `panelRole`, and it is why `MenuItem` can leave its role off.
 *
 * **Home and End belong to the caret while somebody is typing.** Stealing them
 * to jump to the ends of the list means the ends of the *text* cannot be
 * reached, which is a worse trade than the one it buys.
 */

export type MenuProps = {
  /** What the button says. Read by assistive technology, so it names the thing. */
  readonly label: string;
  readonly trigger: ReactNode;
  readonly triggerClassName?: string;
  readonly openClassName?: string;
  /** Which edge of the trigger anchors the panel. */
  readonly placement?:
    | "below-start"
    | "below-end"
    | "above-start"
    | "above-end"
    | "right-start"
    | "right-end";
  /** `dialog` for a panel with a field in it; `menu` for commands alone. */
  readonly panelRole?: "menu" | "dialog";
  /**
   * The trigger element itself, handed to a page that has to reach it later.
   *
   * The panel puts focus back on its own trigger when it closes, so this is not
   * for that. It is for a page whose *item* opens something else — the Running
   * graders list opens an editor beside the table — and which has to put focus
   * back on the row a person came from once that editor closes.
   */
  readonly onTrigger?: (button: HTMLButtonElement | null) => void;
  readonly panelClassName?: string;
  readonly children: (close: () => void) => ReactNode;
};

/**
 * Where each placement puts the panel, as the two things Radix positions by.
 *
 * This is the mechanism rather than a label beside one: change a line here and
 * the panel moves. Radix then writes the side it actually landed on back onto
 * the panel as `data-side`, which is the side after any collision, so a test
 * reading it is reading where the panel is rather than what it was asked for.
 */
const ANCHOR = {
  "below-start": { side: "bottom", align: "start" },
  "below-end": { side: "bottom", align: "end" },
  "above-start": { side: "top", align: "start" },
  "above-end": { side: "top", align: "end" },
  "right-start": { side: "right", align: "start" },
  "right-end": { side: "right", align: "end" },
} as const;

/**
 * One row in a panel, as a class list.
 *
 * `Menu` uses it as the default trigger dress and `MenuItem` wears it, which is
 * why it is named once here rather than written twice. It is exported for the
 * one row that is neither: the shell's dark-theme switch is a `role="switch"`
 * inside the account menu, so it has to look like the items above it without
 * being one.
 */
export const MENU_ITEM = [
  "flex w-full min-h-(--control-md) items-center gap-3 px-3",
  "rounded-button border-0 bg-transparent text-left text-sm text-foreground no-underline",
  "cursor-pointer transition-transform duration-(--duration-press) ease-out",
  "pointer-coarse:min-h-(--tap-target)",
  "pointer-hover:not-disabled:bg-surface-soft",
  "[&:active:not(:focus-visible):not(:disabled)]:scale-97",
  "disabled:cursor-wait disabled:opacity-60",
  "aria-[current=true]:bg-selected",
  "motion-reduce:transition-none",
  "motion-reduce:[&:active:not(:focus-visible):not(:disabled)]:scale-100",
];

/** Whether the caret is somewhere Home and End already mean something. */
function typing(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/** The focusable items inside a panel, in the order they are drawn. */
function itemsIn(panel: HTMLElement | null): readonly HTMLElement[] {
  if (panel === null) return [];
  return [...panel.querySelectorAll<HTMLElement>("[data-menu-item]")];
}

export function Menu({
  label,
  trigger,
  triggerClassName,
  openClassName,
  placement = "below-start",
  panelRole = "menu",
  panelClassName,
  onTrigger,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchor = ANCHOR[placement];

  /**
   * Handing the keyboard back, now rather than after the panel has gone.
   *
   * Radix restores focus itself, one task after the panel is removed. That is
   * right for a panel somebody clicked away from and wrong for the two ways of
   * *finishing* with one — Escape, and choosing something — because
   * `DESIGN.md` says a control answers on press and never after an animation.
   * So those two paths put focus back on the button first and let the panel
   * leave behind them. Radix then sees focus has moved out, stops restoring it
   * a second time, and the panel's exit runs to its end regardless.
   *
   * It is also what keeps the project selector's unsaved-work dialog pointing
   * at the right control. That page walks up from whatever has focus to
   * `[data-slot="menu"]` to find its own trigger — a walk that now finds
   * nothing, because the panel is drawn at the end of the page rather than
   * inside that root, so the walk starts outside it and its answer is always
   * null. What saves it is the fallback: the dialog it opens takes whatever
   * has focus, and by then this has already put that back on the trigger.
   */
  const returnFocus = useCallback(() => triggerRef.current?.focus(), []);

  /**
   * Holding the trigger, and holding it **once**.
   *
   * The callback has to be the same function on every render or React detaches
   * and re-attaches the ref each time, which churns the trigger through null on
   * every keystroke somewhere else on the page. A caller's `onTrigger` is
   * usually written inline at the call site, so it cannot be a dependency: it
   * is kept in a ref and read when the element actually arrives.
   */
  const report = useRef(onTrigger);
  report.current = onTrigger;
  const holdTrigger = useCallback((button: HTMLButtonElement | null) => {
    triggerRef.current = button;
    report.current?.(button);
  }, []);

  const close = useCallback(() => {
    returnFocus();
    setOpen(false);
  }, [returnFocus]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const items = itemsIn(panelRef.current);
    if (items.length === 0) return;

    const here = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, to))]?.focus();
    };

    if (event.key === "ArrowDown") move(here + 1);
    else if (event.key === "ArrowUp") move(here - 1);
    else if (typing(document.activeElement)) return;
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/*
       * The root stays for structure, not for lookup: the panel is portaled
       * to `body`, so nothing can walk up to this slot from a menu item any
       * more. Focus return is owned by `close()`, which focuses the trigger
       * synchronously, and by the dialog's opener fallback above it.
       */}
      <div className="relative" data-slot="menu" data-open={open ? "true" : "false"}>
        <PopoverTrigger
          className={cn(
            triggerClassName ?? MENU_ITEM,
            open ? (openClassName ?? "") : "",
          )}
          ref={holdTrigger}
          aria-haspopup={panelRole}
          aria-label={label}
        >
          {trigger}
        </PopoverTrigger>
        <PopoverContent
          className={cn(
            /*
             * 4px of padding, which is what the boards give a row menu
             * (`9AH-0`): the items are 36px and they are the panel. Eight put a
             * visible margin round a list of four words.
             */
            "w-max p-1",
            /* 210px, which is what the boards draw a row menu at (`9AH-0`). */
            "min-w-[min(var(--menu-width),calc(100vw-var(--space-8)))]",
            "max-w-[min(320px,calc(100vw-var(--space-8)))]",
            /*
             * A panel keeps a gap off the edge it was pushed against, and
             * scrolls rather than running past it. Radix measures the room it
             * has and publishes it; the gap is the theme's smallest step.
             */
            "max-h-[calc(var(--radix-popover-content-available-height)-var(--space-2))]",
            "overflow-y-auto",
            panelClassName,
          )}
          side={anchor.side}
          align={anchor.align}
          role={panelRole}
          aria-label={label}
          ref={panelRef}
          onEscapeKeyDown={returnFocus}
          onOpenAutoFocus={(event) => {
            const panel = panelRef.current;
            const first =
              panel?.querySelector<HTMLElement>("[data-menu-focus-first]") ??
              itemsIn(panel)[0];
            if (first === undefined) return;
            event.preventDefault();
            first.focus();
          }}
          onKeyDown={onKeyDown}
        >
          {children(close)}
        </PopoverContent>
      </div>
    </Popover>
  );
}

/** One thing in a panel: a link somewhere, or a button that does something. */
export function MenuItem({
  href,
  onClick,
  disabled,
  selected,
  /** Left off inside a `dialog` panel, where `menuitem` would not be valid. */
  role = "menuitem",
  children,
}: {
  readonly href?: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly role?: "menuitem" | "none";
  readonly children: ReactNode;
}) {
  const shared = {
    className: cn(MENU_ITEM),
    ...(role === "none" ? {} : { role }),
    "data-menu-item": "",
    ...(selected === undefined ? {} : { "aria-current": selected }),
  };

  if (href !== undefined) {
    return (
      <Link {...shared} href={href} onClick={onClick}>
        {children}
      </Link>
    );
  }

  return (
    <button {...shared} type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 px-3 pt-2 pb-1 text-xs tracking-(--tracking-label) text-faint uppercase">
      {children}
    </p>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}
