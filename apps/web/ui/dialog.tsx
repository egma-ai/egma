"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export type DialogDismiss = (event?: { readonly detail?: number }) => void;

/**
 * Something that takes over the screen until it is answered or dismissed.
 *
 * The compact mobile shell uses one for its navigation, and the authoring
 * tickets after this one will use it for confirmations. So the two rules that
 * are always forgotten are here rather than in each caller: **Escape closes
 * it**, and **opening it moves focus inside** so that a keyboard is not still
 * driving the page underneath.
 *
 * The browser owns the modal lifecycle through its native `dialog`: focus is
 * trapped, the page behind it is inert, and Escape becomes a cancel request.
 * We only restore the exact opener when React removes the dialog. A dialog is
 * never the security boundary and never the only place a fact is stated. It is
 * a way of asking, and closing one always leaves the page as it was.
 *
 * A child function receives the same dismiss path as the close button and the
 * backdrop. Pointer dismissal gets the short exit. Keyboard dismissal stays
 * immediate. Successful writes may still call the owner's `onClose` directly,
 * because the system response should not wait for decoration.
 *
 * **The appearance is here and the motion is not.** Sizes, surfaces and the
 * three shapes are utilities on the elements below. The entrance, the exit and
 * the reduced-motion form of both are in `tailwind-theme.css`, keyed on the
 * `data-slot` and `data-kind` this file writes — the same arrangement the Radix
 * surfaces already use, and for the same reason: an exit that has to finish
 * before the element is removed is a thing a class list says badly.
 */

/** What each shape is, once, so the panel and the scrim cannot disagree. */
const SCRIM_SHAPE = {
  dialog: "open:items-center open:justify-center open:p-5",
  drawer: "open:items-stretch open:justify-start open:p-0",
  sheet: "open:items-stretch open:justify-end open:p-0",
} as const;

const PANEL_SHAPE = {
  dialog: "w-[min(420px,100%)] origin-center p-5",
  drawer: [
    "w-[min(340px,calc(100%-var(--space-7)))] min-h-full origin-left p-5",
    "rounded-[0_var(--radius-lg)_var(--radius-lg)_0] border-y-0 border-l-0",
  ],
  sheet: [
    "flex h-full min-h-full w-[min(640px,100%)] flex-col overflow-hidden",
    "origin-right rounded-none border-y-0 border-r-0 p-0",
    "max-[40rem]:w-full max-[40rem]:rounded-none max-[40rem]:border-l-0",
  ],
} as const;

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
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    closingRef.current = false;
    setClosing(false);
    closeRef.current();
  }, []);

  const requestClose = useCallback((animate: boolean) => {
    if (!animate) {
      finishClose();
      return;
    }
    // Input can change while the dialog is open. A keyboard-opened dialog that
    // is later dismissed with the pointer must use the pointer exit selectors;
    // otherwise it remains inert until the safety timer with no visible motion.
    if (dialogRef.current !== null) dialogRef.current.dataset.input = "pointer";
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    // `transitionend` is the normal path. This fallback prevents a modal from
    // trapping the page if a browser or injected stylesheet drops the event.
    closeTimerRef.current = window.setTimeout(finishClose, 280);
  }, [finishClose]);

  const dismiss = useCallback<DialogDismiss>((event) => {
    requestClose((event?.detail ?? 0) > 0);
  }, [requestClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;

    const opener = returnFocusTo ?? (
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    );
    dialog.dataset.input = opener?.matches(":focus-visible") === true
      ? "keyboard"
      : "pointer";

    // jsdom does not implement the modal methods. Keeping the fallback local
    // lets the rendered component tests prove focus without weakening the real
    // browser path, which always uses `showModal`.
    const hasNativeModal = typeof dialog.showModal === "function";
    const fallbackEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose(false);
    };
    if (hasNativeModal) dialog.showModal();
    else {
      dialog.setAttribute("open", "");
      document.addEventListener("keydown", fallbackEscape);
    }

    const first = dialog.querySelector<HTMLElement>(
      "[autofocus], a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
    );
    (first ?? dialog)?.focus();

    return () => {
      if (!hasNativeModal) document.removeEventListener("keydown", fallbackEscape);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      if (opener?.isConnected === true) opener.focus();
    };
  }, [requestClose, returnFocusTo]);

  return (
    <dialog
      className={cn(
        /*
         * The `<dialog>` element is the scrim. The browser gives it a border, a
         * padding and a centred box of its own, so every one of those is said
         * away here and the layout is the flex box below.
         */
        "fixed inset-0 z-30 m-0 h-full max-h-none w-full max-w-none",
        "overflow-y-auto border-0 bg-transparent p-0 text-foreground",
        /*
         * The scrim colour is a utility and its opacity deliberately is not.
         * Utilities outrank `@layer components`, so an `opacity-100` here would
         * beat the theme rule that fades the backdrop out and the dialog would
         * leave with its scrim still at full strength. A backdrop is opaque by
         * default, so there is nothing to say.
         */
        "backdrop:bg-scrim",
        "open:flex",
        SCRIM_SHAPE[kind],
      )}
      data-slot="dialog-scrim"
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      data-kind={kind}
      data-closing={closing ? "true" : "false"}
      onCancel={(event) => {
        event.preventDefault();
        requestClose(false);
      }}
      onPointerDown={(event) => {
        event.currentTarget.dataset.input = "pointer";
        if (event.target === event.currentTarget) requestClose(true);
      }}
    >
      <div
        className={cn(
          "rounded-card border border-border bg-surface shadow-modal",
          PANEL_SHAPE[kind],
        )}
        data-slot="dialog-panel"
        onTransitionEnd={(event) => {
          if (closing && event.target === event.currentTarget && event.propertyName === "opacity") {
            finishClose();
          }
        }}
      >
        <div
          className={cn(
            "mb-4 flex items-center justify-between gap-4",
            /* A sheet's head is a fixed bar over a scrolling body. */
            kind === "sheet" &&
              "mb-0 flex-none border-b border-border p-5",
          )}
        >
          <h2 className="m-0 text-lg font-medium" id={titleId}>
            {title}
          </h2>
          <button
            className={cn(
              "grid size-(--control-md) shrink-0 place-items-center p-0",
              "rounded-button border border-border bg-surface text-sm text-foreground",
              "cursor-pointer transition-transform duration-(--duration-press) ease-out",
              "pointer-hover:border-border-strong pointer-hover:bg-surface-soft",
              "[&:active:not(:focus-visible)]:scale-97",
              "pointer-coarse:size-(--tap-target)",
              "motion-reduce:transition-none motion-reduce:[&:active:not(:focus-visible)]:scale-100",
            )}
            type="button"
            aria-label="Close"
            onClick={(event) => requestClose(event.detail > 0)}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        {typeof children === "function" ? children(dismiss) : children}
      </div>
    </dialog>
  );
}
