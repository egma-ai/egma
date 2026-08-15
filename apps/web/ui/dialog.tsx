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

  useEffect(() => {
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      "a[href], button:not(:disabled), input, select, textarea",
    );
    (first ?? panel)?.focus();
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
