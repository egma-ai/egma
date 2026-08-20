"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * A button that opens a small panel, and everything that has to be true of one
 * before somebody without a pointer can use it.
 *
 * There are two of these in the shell — the organization and project selector,
 * and the account menu — and there will be more. Writing the behaviour once is
 * what stops the second one being the first one with the keyboard left out:
 *
 * - **Escape closes it and puts focus back on the button**, so a menu opened
 *   by accident is not a trap.
 * - **The arrow keys move between items**, Home and End reach the ends, and
 *   opening moves focus into the panel. Items are found in the DOM rather than
 *   registered by hand, so a panel that grows an item gets it for free.
 * - **A click anywhere else closes it**, and so does moving focus out of it —
 *   tabbing away is a way of leaving, not a way of leaving a panel behind.
 *
 * An item marked `data-menu-focus-first` takes focus when the panel opens. The
 * selector's search field uses it, which is what makes typing to filter work
 * without anybody reaching for the field first.
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
 *
 * The root carries `data-slot="menu"` and the panel carries `data-placement`.
 * The motion — an entrance from the trigger's corner, an exit that finishes
 * before the panel is removed, and the reduced-motion form of both — is in
 * `tailwind-theme.css` keyed on those, beside the same rules for the Radix
 * surfaces.
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
  readonly panelClassName?: string;
  readonly children: (close: () => void) => ReactNode;
};

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
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [input, setInput] = useState<"keyboard" | "pointer">("keyboard");
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const returnFocusRef = useRef(false);

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    closingRef.current = false;
    setClosing(false);
    setOpen(false);
    if (returnFocusRef.current) buttonRef.current?.focus();
    returnFocusRef.current = false;
  }, []);

  const close = useCallback((returnFocus = false, animate = input === "pointer") => {
    returnFocusRef.current = returnFocus;
    if (!animate) {
      finishClose();
      return;
    }
    // The way out can differ from the way in. A keyboard-opened panel that is
    // later dismissed by a pointer must switch to the pointer exit selectors.
    setInput("pointer");
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    // `transitionend` normally finishes this. The timer prevents a hidden menu
    // if a browser, test environment, or injected stylesheet drops the event.
    closeTimerRef.current = window.setTimeout(finishClose, 200);
  }, [finishClose, input]);

  const openPanel = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    closingRef.current = false;
    setClosing(false);
    setOpen(true);
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const elsewhere = (event: Event) => {
      const root = rootRef.current;
      if (
        root !== null &&
        !root.contains(event.target as Node) &&
        !closingRef.current
      ) {
        close(false, event.type === "pointerdown");
      }
    };

    document.addEventListener("pointerdown", elsewhere);
    document.addEventListener("focusin", elsewhere);
    return () => {
      document.removeEventListener("pointerdown", elsewhere);
      document.removeEventListener("focusin", elsewhere);
    };
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const first =
      panel?.querySelector<HTMLElement>("[data-menu-focus-first]") ??
      itemsIn(panel)[0];
    first?.focus();
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    setInput("keyboard");
    if (event.key === "Escape") {
      event.stopPropagation();
      close(true, false);
      return;
    }

    if (!open) return;
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
    <div
      className="relative"
      data-slot="menu"
      ref={rootRef}
      onPointerDownCapture={() => setInput("pointer")}
      onKeyDown={onKeyDown}
      data-open={open ? "true" : "false"}
      data-closing={closing ? "true" : "false"}
      data-input={input}
    >
      <button
        className={cn(
          triggerClassName ?? MENU_ITEM,
          open ? (openClassName ?? "") : "",
        )}
        ref={buttonRef}
        type="button"
        aria-haspopup={panelRole}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => {
          if (closing) openPanel();
          else if (open) close(false);
          else openPanel();
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div
          className={cn(
            /*
             * Where this panel sits is not here. `data-placement` below is the
             * whole of it: `tailwind-theme.css` reads that attribute for the
             * offsets, the corner it grows from, and the extra room the two
             * that hang below the trigger keep off the bottom of the screen.
             * The attribute is the mechanism rather than a label beside one, so
             * removing it moves the panel to the corner of its trigger.
             */
            "absolute z-20 w-max overflow-y-auto p-2",
            "min-w-[min(240px,calc(100vw-var(--space-8)))]",
            "max-w-[min(320px,calc(100vw-var(--space-8)))]",
            "rounded-card border border-border bg-surface shadow-popover",
            panelClassName,
          )}
          data-slot="menu-panel"
          data-placement={placement}
          id={panelId}
          ref={panelRef}
          role={panelRole}
          aria-label={label}
          onTransitionEnd={(event) => {
            if (closing && event.target === event.currentTarget && event.propertyName === "opacity") {
              finishClose();
            }
          }}
        >
          {children(() => close(true))}
        </div>
      ) : null}
    </div>
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
  return <div className="my-2 h-px bg-border" role="separator" />;
}
