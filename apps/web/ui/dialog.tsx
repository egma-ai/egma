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
 * A dialog is never the security boundary and never the only place a fact is
 * stated. It is a way of asking, and closing one always leaves the page as it
 * was.
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  /**
   * Focus goes in when this opens, and **back where it came from** when it
   * closes.
   *
   * The second half was missing, and the shape of what it cost is worth
   * keeping: a keyboard user opened the mobile navigation drawer, pressed
   * Escape, and the focus was on nothing at all — so the next Tab started again
   * from the top of the document, several presses away from the control they
   * had just been on. Nothing looked wrong; a pointer never meets it, and the
   * fast test that would have caught it was called *Escape gives it back*
   * while asserting only that the close handler ran.
   *
   * `isConnected` is the one guard it needs. A dialog is often closed by an act
   * that removes the row it was opened from — a member removed, a grader
   * switched off — and the control that opened it is gone by then. Focusing a
   * detached element does nothing useful, so in that case the page keeps
   * whatever focus it has rather than being sent somewhere arbitrary.
   */
  useEffect(() => {
    const opener = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      "a[href], button:not(:disabled), input, select, textarea",
    );
    (first ?? panel)?.focus();

    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      className={styles.scrim}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
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
    </div>
  );
}
