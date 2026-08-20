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
 * **The centred motion is not here.** `tailwind-theme.css` keys the entrance,
 * the exit and the reduced-motion form of both on the `data-slot` and
 * `data-state` the kit writes. The two edge-attached kinds add the travel that
 * `DESIGN.md` asks of them, because the theme's edge rules were written for the
 * native `<dialog>` this file just retired and the Radix slots have no drawer
 * rule of their own yet.
 */

/**
 * What each shape is, as an override of the kit's centred panel.
 *
 * The kit centres with `-translate-x-1/2 -translate-y-1/2` on the `translate`
 * property and animates `scale`, so position and motion never share a property.
 * The two edge kinds keep that arrangement: they sit at their edge with no
 * centring shift, and the travel below is written on `translate` as well, so
 * the theme's `scale` animation and this file's slide compose instead of
 * cancelling each other.
 */
const PANEL_SHAPE = {
  /* A tall dialog scrolls inside the viewport rather than off it. */
  dialog: "max-h-[calc(100svh-var(--space-8))] overflow-y-auto",
  drawer: [
    "top-0 left-0 h-full max-h-none",
    "w-[min(340px,calc(100vw-var(--space-7)))] translate-x-0 translate-y-0",
    "overflow-y-auto rounded-[0_var(--radius-lg)_var(--radius-lg)_0]",
    "border-y-0 border-l-0",
  ],
  sheet: [
    "top-0 right-0 left-auto h-full max-h-none",
    "w-[min(640px,100vw)] translate-x-0 translate-y-0",
    "gap-0 overflow-hidden rounded-none border-y-0 border-r-0 p-0",
    "max-[40rem]:w-full max-[40rem]:border-l-0",
  ],
} as const;

/**
 * The travel of the two kinds that are attached to an edge.
 *
 * `DESIGN.md`: "Mobile drawer — translate from its attached edge." The theme
 * holds the panel for the length of its `scale` animation, which is what Radix
 * waits for before unmounting, so the slide is given the same two tokens and
 * ends with it rather than being cut off halfway. `@starting-style` is what
 * makes the entrance a movement: without it a panel that mounts already open
 * has nowhere to travel from.
 *
 * Reduced motion drops the transition and nothing else. The panel then arrives
 * and leaves in place, and the opacity the theme still runs is what says a
 * surface came or went.
 */
const PANEL_TRAVEL = {
  dialog: "",
  drawer: [
    "transition-[translate] duration-(--duration-dialog-in) ease-out",
    "starting:-translate-x-full",
    "data-[state=closed]:-translate-x-full",
    "data-[state=closed]:duration-(--duration-dialog-out)",
    "motion-reduce:transition-none",
  ],
  sheet: [
    "transition-[translate] duration-(--duration-dialog-in) ease-out",
    "starting:translate-x-full",
    "data-[state=closed]:translate-x-full",
    "data-[state=closed]:duration-(--duration-dialog-out)",
    "motion-reduce:transition-none",
  ],
} as const;

/** A sheet's head is a fixed bar over a body that scrolls under it. */
const HEAD_SHAPE = {
  dialog: "",
  drawer: "",
  sheet: "flex-none border-b border-border p-5",
} as const;

/**
 * The moment the panel finished leaving.
 *
 * It renders nothing and exists for its unmount: Radix removes the panel only
 * after the closing animation ends, so this component's cleanup is that end.
 * Waiting on it rather than on a timer means the exit is never cut short and
 * never guessed at, and the duration stays in the theme where `DESIGN.md` puts
 * it.
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
  title,
  onClose,
  returnFocusTo,
  children,
}: {
  readonly kind?: "dialog" | "drawer" | "sheet";
  readonly title: string;
  readonly onClose: () => void;
  /** A known trigger to restore when the surface closes. */
  readonly returnFocusTo?: HTMLElement | null;
  readonly children: ReactNode | ((dismiss: DialogDismiss) => ReactNode);
}) {
  const [open, setOpen] = useState(true);
  const closeRef = useRef(onClose);
  const dismissedRef = useRef(false);
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

  /**
   * Focus goes back the moment the panel does, rather than a task later.
   *
   * The kit hands focus back from a timer, which is soon enough to look right
   * and one task too late for anything that reads `document.activeElement`
   * straight after a press. `DESIGN.md` asks a control to answer on press, so
   * this puts focus back as the panel is removed. `onCloseAutoFocus` below
   * keeps the kit from moving it again afterwards, and repeats the same move
   * in case a future version removes the panel differently.
   */
  const restoreFocus = () => {
    const back = returnFocusTo ?? opener;
    if (back !== null && back.isConnected) back.focus();
  };

  return (
    <KitDialog
      open={open}
      modal={TAKES_THE_SCREEN[kind]}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        className={cn(PANEL_SHAPE[kind], PANEL_TRAVEL[kind])}
        data-kind={kind}
        /*
         * Every caller writes its own body, and most bodies are not one
         * sentence a description could stand in for. Saying so removes the
         * attribute rather than pointing it at nothing.
         */
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          // The kit's own answer here is its `DialogTrigger`, which these
          // callers do not use, so this says where focus belongs instead: the
          // control a caller named, or the one that was in hand. An opener
          // removed by the very write this dialog confirmed is left alone —
          // focus falls to the page rather than to something nobody can see.
          event.preventDefault();
          restoreFocus();
        }}
        /*
         * A sheet stays open while the page beside it is used. Without this a
         * press on the grader results would close the transcript being read
         * against them, which is the one thing that page is for.
         */
        onInteractOutside={(event) => {
          if (!TAKES_THE_SCREEN[kind]) event.preventDefault();
        }}
      >
        <DialogHeader className={cn(HEAD_SHAPE[kind])}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {typeof children === "function" ? children(dismiss) : children}
        <ExitGate
          onGone={() => {
            restoreFocus();
            if (!dismissedRef.current) return;
            dismissedRef.current = false;
            closeRef.current();
          }}
        />
      </DialogContent>
    </KitDialog>
  );
}
