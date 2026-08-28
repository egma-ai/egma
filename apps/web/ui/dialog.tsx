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
 * A layer that is answered or dismissed before the page goes on.
 *
 * The compact mobile shell uses one for its navigation, confirmations use one
 * to name what they are about, and the evidence panel is the same surface
 * attached to an edge. So the two rules that are always forgotten are here
 * rather than in each caller: **Escape closes it**, and **opening it moves
 * focus inside** so that a keyboard is not still driving the page underneath.
 *
 * **The modal lifecycle is the kit's.** `components/ui/dialog.tsx` is Radix,
 * and Radix traps focus, makes the page behind it inert, turns Escape into a
 * close, and blocks the page to the pointer while it is up. This file used to
 * do all of that by hand on a native `<dialog>`; it now says only what the kit
 * does not know — which of the three shapes to wear, which of them takes the
 * screen, where focus goes back to, and when the owner may remove it.
 *
 * **`onClose` still means "now take me away", and it is called last.** Owners
 * mount this component and remove it, so an exit has to finish before React
 * unmounts anything: `ExitGate` below sits inside the panel and reports the
 * moment Radix lets go of it, which is the moment the closing animation ended.
 * A dialog is never the security boundary and never the only place a fact is
 * stated. It is a way of asking, and closing one always leaves the page as it
 * was.
 *
 * A child function receives the same dismiss path as the close button and the
 * scrim. Successful writes may still call the owner's `onClose` directly,
 * because the system response should not wait for decoration — the gate below
 * stays quiet on that path rather than closing the same dialog twice.
 *
 * **The motion is not here.** `tailwind-theme.css` keys the entrance, the exit
 * and the reduced-motion form of both on the `data-slot`, `data-kind` and
 * `data-state` the kit and this file write — the centred dialog and the
 * drawer's edge travel alike. The one piece left below is the sheet's travel,
 * which has no token pair of its own to be given a rule for.
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
   * **One side sheet look, in two sizes.** This is the same panel
   * `components/ui/sheet.tsx` draws — right-anchored, Pure Paper behind a
   * hairline on its left edge, no corner, the same travel — and both widths
   * are the theme's rather than numbers written here.
   *
   * The two components are still two, and the difference is behaviour: this
   * one is a *reading* surface that deliberately leaves the page beside it
   * usable, and that one is a modal form portaled inside `<main>`.
   * `size="wide"` is for the reading surface, where the content is a
   * transcript rather than a form and 440px is not enough of a page.
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
 * How long a stuck exit is given before the dialog is taken away anyway.
 *
 * Not a motion value, and deliberately not on the motion scale: it is longer
 * than every exit token so it can never pre-empt one. Both implementations this
 * file replaced carried the same guard, for the same reason — an exit that ends
 * in an event ends in an event that can go missing. A browser that never fires
 * `animationend`, an injected stylesheet that removes the animation, or a tab
 * that was hidden mid-exit would otherwise leave a dismissed dialog mounted,
 * the page behind it hidden from assistive technology, and `onClose` never
 * called.
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
 * Which of the three shapes takes the screen, and which sits beside the work.
 *
 * A confirmation and the mobile navigation are questions: nothing behind them
 * can be reached until they are answered, which is `DESIGN.md`'s "dialogs trap
 * focus, make the background inert". A sheet is not that. It is a panel docked
 * to an edge, the simulation page opens one by default, and that page is built
 * to be read with the transcript open beside the grader results — so a sheet
 * that put the page behind it out of reach would break the page it belongs to.
 *
 * A sheet keeps everything else a dialog has: focus moves into it, Escape
 * closes it, and the control that opened it is focused again afterwards. What
 * it drops is the scrim, the scroll lock, and the inert page.
 *
 * **This is a design call rather than a fact, and it is called out in the pull
 * request for the developer to overrule.** The surface it changes is the
 * transcript-and-audio sheet and the persona version history.
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
   * How much room the surface needs. `wide` is the reading sheet — evidence
   * beside a page — and does nothing to the other two kinds.
   */
  readonly size?: "default" | "wide";
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
   * The keyboard goes back on the press, not at the end of the exit.
   *
   * `DESIGN.md`: "No motion delays input. A control answers on press, not
   * after an animation." Waiting for the panel to finish leaving is a fifth of
   * a second with focus sitting on a button that is on its way out, inside a
   * layer the page behind is still hidden from — a Tab in that window goes
   * nowhere useful. So focus moves the moment the dialog is told to close.
   *
   * **It is an effect rather than a line inside `dismiss`, and the ordering is
   * the reason.** While the dialog is open the kit traps focus and pulls
   * anything that leaves straight back in, so focusing the opener during the
   * press would simply be undone. The trap is released in the same render that
   * closes the dialog, and React runs that release before this effect — so
   * this is the first moment the move can stick, and it is still the same
   * frame as the press.
   *
   * The timer is the other half. See `EXIT_WATCHDOG_MS`.
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
        className={cn(PANEL_SHAPE[kind], size === "wide" && PANEL_WIDE[kind])}
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
           * The kit's own answer here is its `DialogTrigger`, which these
           * callers do not use, so left alone it would drop focus on the page
           * body. Saying no to it is most of the job — focus has already gone
           * back, above, at the press. What is left is the case where it fell
           * to the body anyway, and then this puts it where it belongs. It is
           * deliberately not unconditional: the exit is long enough to Tab
           * during, and pulling focus back off somebody mid-exit would be the
           * same rudeness in the other direction.
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
