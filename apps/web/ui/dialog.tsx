"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  Dialog as KitDialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type DialogDismiss = (event?: { readonly detail?: number }) => void;
export type OutsidePointerDismiss =
  | boolean
  | ((target: EventTarget | null) => boolean);

/**
 * Compose shared dialog primitives into modal dialogs/drawers and nonmodal
 * reading sheets. Manage opener focus and delay owner removal until exit
 * finishes, with a watchdog for missing completion events.
 *
 * Children receive the shared dismiss path. Owners may close immediately after
 * a successful write; ExitGate must not report a second close on that path.
 * Theme selectors own motion through the data attributes.
 */

/**
 * What each shape is, as an override of the kit's centred panel.
 *
 * The kit centres with `-translate-x-1/2 -translate-y-1/2` on the `translate`
 * property and animates `scale`, so position and motion never share a property.
 * The two edge kinds keep that arrangement: they sit at their edge with no
 * centring shift, and their travel is written on `translate` as well, so a
 * `scale` animation and a slide compose instead of cancelling each other.
 */
const PANEL_SHAPE = {
  /* A tall dialog scrolls inside the viewport rather than off it. */
  dialog: "max-h-[calc(100svh-var(--space-8))] overflow-y-auto",
  drawer: [
    "top-0 left-0 h-full max-h-none",
    "w-[min(340px,calc(100vw-var(--space-7)))] translate-x-0 translate-y-0",
    "overflow-y-auto border-y-0 border-l-0",
  ],
  /*
   * Reading sheets share the form sheet's appearance but remain nonmodal.
   * Wide sizes provide room for transcript content while leaving the page usable.
   */
  sheet: [
    "top-0 right-0 left-auto h-full max-h-none",
    "w-[min(var(--sheet-width),100vw)] translate-x-0 translate-y-0",
    "gap-0 overflow-hidden border-y-0 border-r-0 p-0",
    "max-[40rem]:w-full max-[40rem]:border-l-0",
  ],
} as const;

/**
 * The wider panel, for a surface that is read rather than filled in.
 *
 * Only the sheet has one. A dialog is a question and a drawer is a list of
 * places to go; neither gets bigger by holding more.
 */
const PANEL_WIDE = {
  dialog: "",
  drawer: "",
  sheet: "w-[min(var(--sheet-width-wide),100vw)]",
} as const;

/** More room for the production trace rail without changing other readers. */
const PANEL_EXTRA_WIDE = {
  dialog: "",
  drawer: "",
  sheet: "w-[min(var(--sheet-width-extra-wide),100vw)]",
} as const;

/**
 * A sheet's head is a fixed bar over a body that scrolls under it.
 *
 * The hairline is not here any more: `DialogHeader` carries it for every kind,
 * because the boards draw one under a confirmation's title too. What is left is
 * the sheet's own bar — it does not shrink, and its padding is even rather than
 * the dialog head's "under the title only".
 */
const HEAD_SHAPE = {
  dialog: "",
  drawer: "",
  sheet: "flex-none p-5",
} as const;

/**
 * Fallback deadline for an exit that never reports completion. Keep it longer
 * than normal exit motion so dismissal cannot leave the owner mounted indefinitely.
 */
const EXIT_WATCHDOG_MS = 600;

/**
 * The moment the panel finished leaving.
 *
 * It renders nothing and exists for its unmount: Radix removes the panel only
 * after the closing animation ends, so this component's cleanup is that end.
 * Waiting on it rather than on a timer means the exit is never cut short and
 * never guessed at, and the duration stays in the theme where `DESIGN.md` puts
 * it. The watchdog above is the other half of that bargain.
 */
function ExitGate({ onGone }: { readonly onGone: () => void }) {
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => () => gone.current(), []);
  return null;
}

/**
 * Dialogs and navigation drawers are modal. Reading sheets leave the adjacent
 * page usable without an overlay or focus trap.
 */
const TAKES_THE_SCREEN = { dialog: true, drawer: true, sheet: false } as const;

export function Dialog({
  kind = "dialog",
  size = "default",
  title,
  onClose,
  returnFocusTo,
  dismissOnOutsidePointer = false,
  children,
}: {
  readonly kind?: "dialog" | "drawer" | "sheet";
  /**
   * How much room the surface needs. `wide` and `extra-wide` are reading-sheet
   * sizes — evidence beside a page — and do nothing to the other two kinds.
   */
  readonly size?: "default" | "wide" | "extra-wide";
  /** Text for ordinary dialogs, or structured title content for evidence sheets. */
  readonly title: ReactNode;
  readonly onClose: () => void;
  /** A known trigger to restore when the surface closes. */
  readonly returnFocusTo?: HTMLElement | null;
  /**
   * Let a primary pointer press on the usable page beside a reading sheet
   * dismiss it. A predicate may preserve an outside control that replaces the
   * sheet's record. Keyboard focus moving outside never dismisses the sheet.
   */
  readonly dismissOnOutsidePointer?: OutsidePointerDismiss;
  readonly children: ReactNode | ((dismiss: DialogDismiss) => ReactNode);
}) {
  const [open, setOpen] = useState(true);
  const closeRef = useRef(onClose);
  const dismissedRef = useRef(false);
  const outsidePointerRef = useRef(false);
  const outsideFocusTargetRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  closeRef.current = onClose;

  /**
   * The control that was in hand when this dialog appeared.
   *
   * Read while rendering rather than in an effect, because by the time an
   * effect runs the kit has already moved focus inside the panel and the
   * answer is gone. Owners mount this component instead of opening it from a
   * `DialogTrigger`, so the kit has no trigger of its own to go back to and
   * would otherwise leave focus on the page body.
   */
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  const dismiss = useCallback<DialogDismiss>(() => {
    dismissedRef.current = true;
    setOpen(false);
  }, []);

  const backRef = useRef<HTMLElement | null>(null);
  backRef.current = returnFocusTo ?? opener;

  const restoreFocus = () => {
    const back = backRef.current;
    if (back !== null && back.isConnected) back.focus();
  };

  /**
   * Restore focus after the closing render releases the modal trap, without
   * waiting for animation. Preserve focus already moved outside, including the
   * control clicked to dismiss a nonmodal sheet. Arm the exit watchdog.
   */
  useEffect(() => {
    if (open) return undefined;
    const outsideTarget = outsideFocusTargetRef.current;
    const active = document.activeElement;
    const focusAlreadyMovedOutside =
      active instanceof HTMLElement &&
      active !== document.body &&
      active.isConnected &&
      !panelRef.current?.contains(active);
    if (!focusAlreadyMovedOutside) {
      if (outsidePointerRef.current && outsideTarget?.isConnected) {
        outsideTarget.focus();
      } else {
        restoreFocus();
      }
    }
    const forced = window.setTimeout(() => {
      if (!dismissedRef.current) return;
      dismissedRef.current = false;
      closeRef.current();
    }, EXIT_WATCHDOG_MS);
    return () => window.clearTimeout(forced);
    // `restoreFocus` reads a ref, so it needs no dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <KitDialog
      open={open}
      modal={TAKES_THE_SCREEN[kind]}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        className={cn(
          PANEL_SHAPE[kind],
          size === "wide" && PANEL_WIDE[kind],
          size === "extra-wide" && PANEL_EXTRA_WIDE[kind],
        )}
        ref={panelRef}
        showOverlay={TAKES_THE_SCREEN[kind]}
        data-kind={kind}
        /*
         * Every caller writes its own body, and most bodies are not one
         * sentence a description could stand in for. Saying so removes the
         * attribute rather than pointing it at nothing.
         */
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          /*
           * These callers do not use DialogTrigger. Suppress default restoration and
           * restore the opener only if focus fell to body; do not steal focus that the
           * user moved during exit.
           */
          event.preventDefault();
          if (
            !outsidePointerRef.current &&
            document.activeElement === document.body
          ) {
            restoreFocus();
          }
        }}
        /*
         * A reading sheet keeps the page beside it usable. Most callers also
         * keep the sheet open while that page is used, because the simulation
         * results are read against their evidence. A production transcript
         * opts into pointer dismissal: only a primary press closes it. Moving
         * keyboard focus outside does not.
         */
        onInteractOutside={(event) => {
          if (TAKES_THE_SCREEN[kind]) return;
          const original = event.detail.originalEvent;
          const primaryPointer =
            original.type === "pointerdown" &&
            (!("button" in original) || original.button === 0);
          if (!primaryPointer) {
            event.preventDefault();
            return;
          }
          const shouldDismiss =
            typeof dismissOnOutsidePointer === "function"
              ? dismissOnOutsidePointer(original.target)
              : dismissOnOutsidePointer;
          if (!shouldDismiss) {
            event.preventDefault();
            return;
          }

          outsidePointerRef.current = true;
          const target = original.target;
          const focusTarget =
            target instanceof Element
              ? target.closest<HTMLElement>(
                  "button,a[href],input,select,textarea,[tabindex]:not([tabindex='-1'])",
                )
              : null;
          outsideFocusTargetRef.current = focusTarget;
        }}
      >
        <DialogHeader className={cn(HEAD_SHAPE[kind])}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {typeof children === "function" ? children(dismiss) : children}
        <ExitGate
          onGone={() => {
            if (!dismissedRef.current) return;
            dismissedRef.current = false;
            closeRef.current();
          }}
        />
      </DialogContent>
    </KitDialog>
  );
}
