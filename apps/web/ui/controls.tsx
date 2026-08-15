"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./system.module.css";

/**
 * The controls a product page is built from: a button, a link that looks like
 * one, a labelled field, and a small status badge.
 *
 * Two weights and no more. `strong` carries the one thing a page is mainly for;
 * everything else is `quiet`. A page with three strong buttons has told
 * somebody nothing about which one they came for.
 */

export type Weight = "strong" | "quiet";

function weightClass(weight: Weight): string {
  return weight === "strong" ? styles.button : styles.buttonQuiet;
}

export function Button({
  weight = "quiet",
  type = "button",
  disabled,
  onClick,
  children,
}: {
  readonly weight?: Weight;
  readonly type?: "button" | "submit";
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      className={weightClass(weight)}
      type={type}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Somewhere to go, dressed as a control — and what it becomes when whoever is
 * looking at it may not go there.
 *
 * **A disabled control is genuinely inert or it is a lie.** A link cannot be
 * disabled: `aria-disabled` on an anchor greys it out and it still follows on
 * click and still takes the keyboard. So when this is not available it stops
 * being a link and becomes a disabled `button` — unfocusable, unclickable, and
 * disabled to assistive technology because the element really is.
 *
 * It stays on the page rather than disappearing. One page, one layout, and a
 * viewer is told plainly that an action is not theirs instead of quietly not
 * being shown that it exists. `why` is the sentence they get for asking.
 *
 * None of this is authorization. The server checks the same permission on
 * every request and refuses a viewer's write whether or not a browser was
 * involved; this is a courtesy to a reader, and never a lock.
 */
export function ButtonLink({
  href,
  weight = "quiet",
  disabled = false,
  why,
  children,
}: {
  readonly href: string;
  readonly weight?: Weight;
  readonly disabled?: boolean;
  /** Why it is not available, for whoever hovers or focuses it. */
  readonly why?: string;
  readonly children: ReactNode;
}) {
  if (disabled) {
    return (
      <button className={weightClass(weight)} type="button" disabled title={why}>
        {children}
      </button>
    );
  }

  return (
    <Link className={weightClass(weight)} href={href}>
      {children}
    </Link>
  );
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function TextInput({
  id,
  value,
  placeholder,
  label,
  autoFocusFirst = false,
  onChange,
  onKeyDown,
}: {
  readonly id: string;
  readonly value: string;
  readonly placeholder?: string;
  /** When the field carries its own name rather than a visible label. */
  readonly label?: string;
  /** Whether an opening menu should put focus here. */
  readonly autoFocusFirst?: boolean;
  readonly onChange: (value: string) => void;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      className={styles.input}
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      {...(autoFocusFirst ? { "data-menu-focus-first": "" } : {})}
    />
  );
}

export type BadgeTone = "neutral" | "good" | "bad" | "warn";

const TONE: Record<BadgeTone, string> = {
  neutral: "",
  good: styles.badgeGood,
  bad: styles.badgeBad,
  warn: styles.badgeWarn,
};

/**
 * A small, quiet statement of state: a role, an archive state, a verdict.
 *
 * It never carries an action. A badge somebody can click is a button that has
 * been made hard to see.
 */
export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  readonly tone?: BadgeTone;
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${TONE[tone]}`} title={title}>
      {children}
    </span>
  );
}
