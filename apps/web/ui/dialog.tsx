"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import styles from "./system.module.css";

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
 */

export function Dialog({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;

    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    // jsdom does not implement the modal methods. Keeping the fallback local
    // lets the rendered component tests prove focus without weakening the real
    // browser path, which always uses `showModal`.
    const hasNativeModal = typeof dialog.showModal === "function";
    const fallbackEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
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
  }, []);

  return (
    <dialog
      className={styles.scrim}
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
      >
        <div className={styles.dialogHead}>
          <h2 className={styles.dialogTitle} id={titleId}>
            {title}
          </h2>
          <button
            className={styles.iconButton}
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
