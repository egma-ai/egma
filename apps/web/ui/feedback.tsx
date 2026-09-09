"use client";

import { CircleCheckIcon, OctagonXIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  Tooltip as TooltipRoot,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type FeedbackInput = "keyboard" | "pointer";

/**
 * Use shared tooltip behavior for timing, placement, Escape, and accessible
 * descriptions. Track input type for keyboard-specific exit styling.
 * Each tooltip owns a provider, so the instant-reopen window is per tooltip,
 * not shared across neighboring controls. Tooltips must contain no actions.
 */
export function Tooltip({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactElement;
}) {
  const [input, setInput] = useState<FeedbackInput>("keyboard");
  const hovered = useRef(false);

  return (
    <TooltipRoot>
      <TooltipTrigger
        asChild
        onPointerMove={() => {
          hovered.current = true;
          setInput("pointer");
        }}
        onPointerLeave={() => {
          hovered.current = false;
        }}
        onFocus={() => {
          /*
           * A press moves focus as well, and that is a pointer's tooltip. Radix
           * makes the same distinction for whether to open at all.
           */
          if (!hovered.current) setInput("keyboard");
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent data-input={input}>{label}</TooltipContent>
    </TooltipRoot>
  );
}

/**
 * Controlled notification with pointer exit motion and immediate keyboard
 * dismissal. Keep it mounted while closing and cancel closure when reopened.
 * Theme attributes select motion; text and icons convey status without color alone.
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

  const Mark = kind === "error" ? OctagonXIcon : CircleCheckIcon;

  return (
    <aside
      className={cn(
        "fixed right-6 bottom-6 z-50 grid items-center",
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
      {/*
       * Use the same status/error icons as queued notifications. Shape and text
       * carry the meaning; color is supporting information.
       */}
      <Mark
        className={cn(
          "size-4 justify-self-center",
          kind === "error" ? "text-failure" : "text-foreground",
        )}
        aria-hidden="true"
        data-slot="toast-mark"
      />
      <span className="grid min-w-0 gap-1 text-sm [&>span]:text-muted-foreground [&_strong]:font-medium">
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
        <XIcon className="size-4" />
      </button>
    </aside>
  );
}
