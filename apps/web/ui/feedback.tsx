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
 * A short explanation attached to one control.
 *
 * Keyboard focus shows it at once and without movement. A pointer gets a short
 * delay before the first one, which prevents accidental flashes while it
 * crosses the page, and the same trigger hovered again straight after opens at
 * once. The tooltip never holds an action; interactive help belongs in a menu
 * or dialog.
 *
 * **All of the timing, the positioning, the Escape, and the `aria-describedby`
 * are the kit's now**, which is Radix's. What used to be here was a hand-written
 * pair of timers, a module-level timestamp shared between every tooltip on the
 * page, and a panel hard-centred over its trigger that ran off the side of a
 * narrow window rather than answering the edge.
 *
 * One thing that global timestamp did is not replaced, and mounting a provider
 * would not replace it. Radix keeps the "open the next one at once" window on
 * the provider, and the kit's `Tooltip` wraps every root in a provider of its
 * own, so each tooltip only ever groups with itself: this trigger re-hovered
 * is instant, its neighbour still waits the full delay. A provider mounted
 * higher up changes nothing, because the nearest one wins and the nearest one
 * is always the inner one. Restoring the shared window means removing that
 * wrapper *and* mounting one provider above the product — two files at once,
 * recorded with the coordinator rather than done here.
 *
 * `data-input` is only read by the exit: Radix reports "closed" the same way
 * whichever input opened it, and a keyboard close must not wait for a movement.
 * It is set on the way in rather than on the way out, so it is already true by
 * the time the exit runs.
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
 * One controlled, interruptible product notification.
 *
 * It stays mounted for a pointer dismissal so its exit can finish. Keyboard
 * activation and dismissal are instant. The visible word and symbol carry the
 * state together, so the notification never depends on color alone.
 *
 * **It is not built on the kit's sonner Toaster, deliberately.** `DESIGN.md`
 * asks a toast for a short translate plus opacity on an *interruptible
 * transition*; sonner leaves on a CSS animation and a fixed unmount timer, so
 * a dismissal cannot be answered at once. A page here also says whether this
 * notification is open, rather than pushing into a queue that owns it.
 * `components/ui/sonner.tsx` is house-correct and waiting for the surface that
 * wants a queue; the icons below are its icons, so the two read as one product.
 *
 * The motion itself is in `tailwind-theme.css`, keyed on `data-slot`,
 * `data-input` and `data-closing`, so position and motion never share a
 * property and the reduced-motion form is written beside the full one.
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
        "fixed right-6 bottom-6 z-50 grid items-start",
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
       * The shape says which state this is and the colour only supports it: a
       * ticked circle against a crossed octagon reads as two different things
       * with no colour at all. Neutral for "this happened" and the failure
       * colour for "this went wrong" — never the brand colour, which
       * `DESIGN.md` keeps away from every semantic result.
       *
       * They are the icons `components/ui/sonner.tsx` draws for the same two
       * states, so a queued notification and this one would not arrive looking
       * like two different products.
       */}
      <Mark
        className={cn(
          "size-4 justify-self-center",
          kind === "error" ? "text-failure" : "text-foreground",
        )}
        aria-hidden="true"
        data-slot="toast-mark"
      />
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
        <XIcon className="size-4" />
      </button>
    </aside>
  );
}
