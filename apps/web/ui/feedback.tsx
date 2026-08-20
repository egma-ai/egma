"use client";

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export type FeedbackInput = "keyboard" | "pointer";

type TooltipTriggerProps = {
  readonly "aria-describedby"?: string;
  readonly onBlur?: FocusEventHandler<HTMLElement>;
  readonly onFocus?: FocusEventHandler<HTMLElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
  readonly onPointerEnter?: PointerEventHandler<HTMLElement>;
  readonly onPointerLeave?: PointerEventHandler<HTMLElement>;
};

let lastPointerTooltipAt = 0;
const FIRST_TOOLTIP_DELAY = 500;
const TOOLTIP_WARM_WINDOW = 1_000;

/**
 * A short explanation attached to one control.
 *
 * Keyboard focus shows it at once and without movement. A pointer gets a short
 * delay before the first tooltip, which prevents accidental flashes while it
 * crosses the page. Nearby tooltips then open at once. The tooltip never holds
 * an action; interactive help belongs in a menu or dialog.
 *
 * It is centred on its trigger with `translate` and it arrives on `scale`, so
 * the two never share a property. The arrival itself is in `tailwind-theme.css`
 * keyed on `data-slot`, `data-input` and `data-instant`.
 */
export function Tooltip({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactElement<TooltipTriggerProps>;
}) {
  const id = useId();
  const [present, setPresent] = useState(false);
  const [closing, setClosing] = useState(false);
  const [input, setInput] = useState<FeedbackInput>("keyboard");
  const [instant, setInstant] = useState(true);
  const focusedRef = useRef(false);
  const hoveredRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setClosing(false);
    setPresent(false);
  }, []);

  const close = useCallback((animate: boolean) => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
    if (!present || !animate || input !== "pointer" || instant) {
      finishClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(finishClose, 200);
  }, [finishClose, input, instant, present]);

  const openForKeyboard = useCallback(() => {
    clearTimers();
    setInput("keyboard");
    setInstant(true);
    setClosing(false);
    setPresent(true);
  }, [clearTimers]);

  const openForPointer = useCallback(() => {
    clearTimers();
    const now = Date.now();
    const warm =
      lastPointerTooltipAt > 0 && now - lastPointerTooltipAt < TOOLTIP_WARM_WINDOW;
    setInput("pointer");
    setInstant(warm);
    const show = () => {
      openTimerRef.current = null;
      if (!hoveredRef.current) return;
      lastPointerTooltipAt = Date.now();
      setClosing(false);
      setPresent(true);
    };
    if (warm) show();
    else openTimerRef.current = window.setTimeout(show, FIRST_TOOLTIP_DELAY);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const describedBy = [children.props["aria-describedby"], present ? id : undefined]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" ") || undefined;

  const trigger = cloneElement(children, {
    "aria-describedby": describedBy,
    onFocus: (event) => {
      children.props.onFocus?.(event);
      focusedRef.current = true;
      if (!hoveredRef.current) openForKeyboard();
    },
    onBlur: (event) => {
      children.props.onBlur?.(event);
      focusedRef.current = false;
      if (!hoveredRef.current) close(false);
    },
    onPointerEnter: (event) => {
      children.props.onPointerEnter?.(event);
      hoveredRef.current = true;
      openForPointer();
    },
    onPointerLeave: (event) => {
      children.props.onPointerLeave?.(event);
      hoveredRef.current = false;
      if (!focusedRef.current) close(true);
    },
    onKeyDown: (event) => {
      children.props.onKeyDown?.(event);
      if (event.key === "Escape" && present) {
        event.stopPropagation();
        close(false);
      }
    },
  });

  return (
    <span className="relative inline-flex">
      {trigger}
      {present ? (
        <span
          className={cn(
            "pointer-events-none absolute bottom-[calc(100%+var(--space-2))] left-1/2 z-40",
            "w-max max-w-[min(240px,calc(100vw-var(--space-7)))] -translate-x-1/2",
            "rounded-button border border-foreground bg-foreground px-3 py-2",
            "origin-bottom text-sm text-surface",
          )}
          data-slot="tooltip"
          id={id}
          role="tooltip"
          data-input={input}
          data-instant={instant ? "true" : "false"}
          data-closing={closing ? "true" : "false"}
          onTransitionEnd={(event) => {
            if (
              closing &&
              event.target === event.currentTarget &&
              event.propertyName === "opacity"
            ) finishClose();
          }}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One controlled, interruptible product notification.
 *
 * It stays mounted for a pointer dismissal so its exit can finish. Keyboard
 * activation and dismissal are instant. The visible word and symbol carry the
 * state together, so the notification never depends on color alone.
 */
export function Toast({
  open,
  input = "keyboard",
  title,
  kind = "status",
  onDismiss,
  children,
}: {
  readonly open: boolean;
  readonly input?: FeedbackInput;
  readonly title: string;
  readonly kind?: "status" | "error";
  readonly onDismiss: (input: FeedbackInput) => void;
  readonly children?: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setClosing(false);
    setPresent(false);
  }, []);

  useEffect(() => {
    if (open) {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
      setClosing(false);
      setPresent(true);
      return;
    }
    if (!present) return;
    if (input === "keyboard") {
      finishClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(finishClose, 220);
  }, [finishClose, input, open, present]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  if (!present) return null;

  return (
    <aside
      className={cn(
        /* `group`, so the mark inside can read the toast's own kind. */
        "group fixed right-6 bottom-6 z-50 grid items-start",
        "w-[min(380px,calc(100vw-(2*var(--space-4))))] min-h-(--tap-target)",
        "grid-cols-[var(--control-sm)_minmax(0,1fr)_var(--control-sm)] gap-3 p-3",
        "rounded-card border border-border border-l-2 border-l-foreground",
        "bg-surface text-foreground shadow-popover",
        /* The failure colour, for the reason written on `app/ui.tsx`'s notice. */
        "data-[kind=error]:border-l-failure",
        "max-[640px]:right-4 max-[640px]:bottom-4",
      )}
      data-slot="toast"
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      data-kind={kind}
      data-input={input}
      data-closing={closing ? "true" : "false"}
      onTransitionEnd={(event) => {
        if (
          closing &&
          event.target === event.currentTarget &&
          event.propertyName === "opacity"
        ) finishClose();
      }}
    >
      <span
        className={cn(
          "grid size-(--control-sm) place-items-center",
          "rounded-chip border border-foreground text-sm",
          "group-data-[kind=error]:border-failure",
        )}
        aria-hidden="true"
      >
        {kind === "error" ? "!" : "✓"}
      </span>
      <span className="grid min-w-0 gap-1 pt-1 text-sm [&>span]:text-muted-foreground [&_strong]:font-medium">
        <strong>{title}</strong>
        {children === undefined ? null : <span>{children}</span>}
      </span>
      <button
        className={cn(
          "grid size-(--control-sm) cursor-pointer place-items-center p-0",
          "rounded-button border-0 bg-transparent text-muted-foreground",
          "transition-transform duration-(--duration-press) ease-out",
          "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
          "[&:active:not(:focus-visible)]:scale-97",
          "motion-reduce:transition-none",
          "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
        )}
        type="button"
        aria-label={`Dismiss ${title}`}
        onClick={(event) => onDismiss(event.detail > 0 ? "pointer" : "keyboard")}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </aside>
  );
}
