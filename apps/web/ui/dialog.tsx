"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import styles from "./system.module.css";

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
 */

export function Dialog({
  kind = "dialog",
  title,
  onClose,
  children,
}: {
  readonly kind?: "dialog" | "drawer";
  readonly title: string;
  readonly onClose: () => void;
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

    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
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
      opener?.focus();
    };
  }, [requestClose]);

  return (
    <dialog
      className={`${styles.scrim} ${kind === "drawer" ? styles.scrimDrawer : ""}`}
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
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
        className={`${styles.dialog} ${kind === "drawer" ? styles.dialogDrawer : ""}`}
        onTransitionEnd={(event) => {
          if (closing && event.target === event.currentTarget && event.propertyName === "opacity") {
            finishClose();
          }
        }}
      >
        <div className={styles.dialogHead}>
          <h2 className={styles.dialogTitle} id={titleId}>
            {title}
          </h2>
          <button
            className={styles.iconButton}
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
